import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v2 as cloudinary } from 'cloudinary';
import { extractIDCardData as extractWithAzure } from './services/azureFormRecognizer.js';
import { compareFaces, isFaceVerificationAvailable, initializeFaceVerification } from './services/faceVerification.js';

dotenv.config();

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLAUDINARY_API_NAME,
  api_key: process.env.CLAUDINARY_API_KEY,
  api_secret: process.env.CLAUDINARY_API_SECRET,
});

// Helper function to upload base64 image to Cloudinary
async function uploadToCloudinary(base64Image, folder = 'kyc') {
  try {
    const result = await cloudinary.uploader.upload(base64Image, {
      folder: folder,
      resource_type: 'image',
    });
    return { success: true, url: result.secure_url, publicId: result.public_id };
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    return { success: false, error: error.message };
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// MongoDB Connection
let db;
const mongoClient = new MongoClient(process.env.MONGODB_URI);

async function connectDB() {
  try {
    await mongoClient.connect();
    db = mongoClient.db(process.env.DB_NAME || 'nft_voting');
    console.log('Connected to MongoDB');
    
    // Create indexes
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('users').createIndex({ googleId: 1 }, { sparse: true });
    await db.collection('kyc_requests').createIndex({ userId: 1 });
    await db.collection('votings').createIndex({ status: 1 });
    await db.collection('votes').createIndex({ votingId: 1, oderId: 1 });
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Google OAuth Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Gemini AI Client for ID Card Extraction
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'AIzaSyClNpYcvUiiPG7HkvJi26AkOp96DXbsAjk');

// Email Transporter
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Blockchain Configuration
const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
const adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

// Contract ABIs (minimal)
const VOTER_NFT_ABI = [
  "function mintVoterNFT(address to, tuple(string name, string fatherName, string motherName, string dateOfBirth, string nidNumber, string residentialArea, string ipfsMetadataHash) voterInfo) external returns (uint256)",
  "function isVerifiedVoter(address voter) external view returns (bool)",
  "function getVoterInfo(address voter) external view returns (uint256 tokenId, string area, bool verified, uint256 regTime)",
  "function totalRegisteredVoters() external view returns (uint256)",
  "function isNIDRegistered(string nidNumber) external view returns (bool)",
  "function isRegistered(address wallet) external view returns (bool)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "event VoterRegistered(uint256 indexed tokenId, address indexed voterAddress, string residentialArea, bytes32 dataHash, uint256 timestamp)"
];

const VOTING_SYSTEM_ABI = [
  "function createElection(string title, string description, uint256 startTime, uint256 endTime, string[] eligibleAreas) external returns (uint256)",
  "function addCandidate(uint256 electionId, string name, string party, string description) external returns (uint256)",
  "function castVote(uint256 electionId, uint256 candidateId) external",
  "function getElectionInfo(uint256 electionId) external view returns (tuple(uint256 id, string title, string description, uint256 startTime, uint256 endTime, string[] eligibleAreas, uint256 candidateCount, uint256 totalVotes, bool isActive, bool resultsFinalized, address creator))",
  "function getElectionCandidates(uint256 electionId) external view returns (tuple(uint256 id, string name, string party, string description, uint256 voteCount)[])",
  "function getElectionCount() external view returns (uint256)",
  "function hasVoterVoted(uint256 electionId, address voter) external view returns (bool)",
  "event VoteCast(uint256 indexed electionId, uint256 indexed candidateId, address indexed voter, uint256 chainId, bytes32 voteHash, uint256 timestamp)",
  "event ElectionCreated(uint256 indexed electionId, string title, uint256 startTime, uint256 endTime, address creator)"
];

const voterNFTContract = new ethers.Contract(process.env.VOTER_NFT_ADDRESS, VOTER_NFT_ABI, adminWallet);
const votingSystemContract = new ethers.Contract(process.env.VOTING_SYSTEM_ADDRESS, VOTING_SYSTEM_ABI, adminWallet);

// JWT Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ code: 'ERROR', msg: 'Access token required' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ code: 'ERROR', msg: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Admin Middleware
async function requireAdmin(req, res, next) {
  try {
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
    if (!user || !user.isAdmin) {
      return res.status(403).json({ code: 'ERROR', msg: 'Admin access required' });
    }
    next();
  } catch (error) {
    res.status(500).json({ code: 'ERROR', msg: 'Server error' });
  }
}

// ============================================
// Health Check
// ============================================
app.get('/api/health', async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.json({ status: 'ok', database: 'disconnected' });
  }
});

// ============================================
// Auth Routes
// ============================================

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ code: 'ERROR', msg: 'All fields are required', data: null });
    }
    
    // Check if user exists
    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).json({ code: 'ERROR', msg: 'Email already registered', data: null });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Generate verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    
    // Create user
    const user = {
      name,
      email,
      password: hashedPassword,
      isEmailVerified: false,
      isAdmin: false,
      kycStatus: 'not_submitted',
      verificationCode,
      verificationExpiry,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    const result = await db.collection('users').insertOne(user);
    
    // Send verification email
    try {
      await emailTransporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'NFT Voting - Verify Your Email',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #3b82f6;">Welcome to NFT Voting System!</h2>
            <p>Hi ${name},</p>
            <p>Your verification code is:</p>
            <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1f2937;">${verificationCode}</span>
            </div>
            <p>This code will expire in 15 minutes.</p>
            <p>If you didn't create an account, please ignore this email.</p>
          </div>
        `,
      });
    } catch (emailError) {
      console.error('Email send error:', emailError);
    }
    
    res.json({
      code: 'SUCCESS',
      msg: 'Registration successful! Please check your email for verification code.',
      data: { userId: result.insertedId.toString(), message: 'Verification code sent to email' }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Verify Email
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return res.status(404).json({ code: 'ERROR', msg: 'User not found' });
    }
    
    if (user.isEmailVerified) {
      return res.json({ code: 'SUCCESS', msg: 'Email already verified' });
    }
    
    if (user.verificationCode !== code) {
      return res.status(400).json({ code: 'ERROR', msg: 'Invalid verification code' });
    }
    
    if (new Date() > user.verificationExpiry) {
      return res.status(400).json({ code: 'ERROR', msg: 'Verification code expired' });
    }
    
    await db.collection('users').updateOne(
      { _id: user._id },
      { 
        $set: { isEmailVerified: true, updatedAt: new Date() },
        $unset: { verificationCode: '', verificationExpiry: '' }
      }
    );
    
    res.json({ code: 'SUCCESS', msg: 'Email verified successfully' });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error' });
  }
});

// Resend Verification Code
app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return res.status(404).json({ code: 'ERROR', msg: 'User not found' });
    }
    
    if (user.isEmailVerified) {
      return res.json({ code: 'SUCCESS', msg: 'Email already verified' });
    }
    
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
    
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { verificationCode, verificationExpiry, updatedAt: new Date() } }
    );
    
    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NFT Voting - New Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #3b82f6;">New Verification Code</h2>
          <p>Your new verification code is:</p>
          <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1f2937;">${verificationCode}</span>
          </div>
          <p>This code will expire in 15 minutes.</p>
        </div>
      `,
    });
    
    res.json({ code: 'SUCCESS', msg: 'New verification code sent' });
  } catch (error) {
    console.error('Resend code error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return res.status(401).json({ code: 'ERROR', msg: 'Invalid email or password', data: null });
    }
    
    // Check if user signed up with Google
    if (user.googleId && !user.password) {
      return res.status(401).json({ code: 'ERROR', msg: 'Please login with Google', data: null });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ code: 'ERROR', msg: 'Invalid email or password', data: null });
    }
    
    if (!user.isEmailVerified) {
      return res.status(403).json({ 
        code: 'EMAIL_NOT_VERIFIED', 
        msg: 'Please verify your email first', 
        data: { email: user.email }
      });
    }
    
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'Login successful',
      data: {
        token,
        userId: user._id.toString(),
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          isEmailVerified: user.isEmailVerified,
          isAdmin: user.isAdmin,
          kycStatus: user.kycStatus,
          walletAddress: user.walletAddress,
          nftTokenId: user.nftTokenId,
          nftChain: user.nftChain,
          residentialArea: user.residentialArea,
        }
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Wallet Authentication - Get Nonce
app.get('/api/auth/wallet/nonce', async (req, res) => {
  try {
    const { address } = req.query;
    
    if (!address) {
      return res.status(400).json({ code: 'ERROR', msg: 'Wallet address required' });
    }
    
    // Generate a random nonce
    const nonce = uuidv4();
    
    // Store nonce with expiration (5 minutes)
    await db.collection('wallet_nonces').updateOne(
      { address: address.toLowerCase() },
      { 
        $set: { 
          nonce, 
          expiresAt: new Date(Date.now() + 5 * 60 * 1000) 
        } 
      },
      { upsert: true }
    );
    
    res.json({ code: 'SUCCESS', nonce });
  } catch (error) {
    console.error('Nonce generation error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Failed to generate nonce' });
  }
});

// Wallet Authentication - Verify Signature
app.post('/api/auth/wallet/verify', async (req, res) => {
  try {
    const { address, signature, nonce } = req.body;
    
    if (!address || !signature || !nonce) {
      return res.status(400).json({ code: 'ERROR', msg: 'Address, signature, and nonce required' });
    }
    
    // Verify nonce
    const nonceDoc = await db.collection('wallet_nonces').findOne({ 
      address: address.toLowerCase(),
      nonce,
      expiresAt: { $gt: new Date() }
    });
    
    if (!nonceDoc) {
      return res.status(400).json({ code: 'ERROR', msg: 'Invalid or expired nonce' });
    }
    
    // Verify signature
    const message = `Sign this message to authenticate with NFT Voting System.\n\nNonce: ${nonce}\nAddress: ${address}`;
    const recoveredAddress = ethers.verifyMessage(message, signature);
    
    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ code: 'ERROR', msg: 'Invalid signature' });
    }
    
    // Delete used nonce
    await db.collection('wallet_nonces').deleteOne({ address: address.toLowerCase() });
    
    // Find or create user with wallet
    let user = await db.collection('users').findOne({ walletAddress: address.toLowerCase() });
    
    if (!user) {
      // Create new user with wallet
      const newUser = {
        name: `User ${address.slice(0, 6)}`,
        walletAddress: address.toLowerCase(),
        isEmailVerified: true, // Wallet verified
        isAdmin: false,
        kycStatus: 'not_submitted',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await db.collection('users').insertOne(newUser);
      user = { ...newUser, _id: result.insertedId };
    }
    
    const token = jwt.sign(
      { userId: user._id.toString(), walletAddress: address.toLowerCase() },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'Wallet authenticated successfully',
      data: {
        token,
        userId: user._id.toString(),
        user: {
          id: user._id.toString(),
          email: user.email || '',
          name: user.name,
          isEmailVerified: true,
          isAdmin: user.isAdmin || false,
          kycStatus: user.kycStatus || 'not_submitted',
          walletAddress: user.walletAddress,
          nftTokenId: user.nftTokenId,
        },
      },
    });
  } catch (error) {
    console.error('Wallet verification error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Authentication failed' });
  }
});

// Google OAuth
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;
    
    let user = await db.collection('users').findOne({ $or: [{ googleId }, { email }] });
    
    if (user) {
      // Update existing user with Google info if needed
      if (!user.googleId) {
        await db.collection('users').updateOne(
          { _id: user._id },
          { $set: { googleId, picture, isEmailVerified: true, updatedAt: new Date() } }
        );
      }
    } else {
      // Create new user
      const newUser = {
        name,
        email,
        googleId,
        picture,
        isEmailVerified: true,
        isAdmin: false,
        kycStatus: 'not_submitted',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await db.collection('users').insertOne(newUser);
      user = { ...newUser, _id: result.insertedId };
    }
    
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'Login successful',
      data: {
        token,
        userId: user._id.toString(),
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          isEmailVerified: true,
          isAdmin: user.isAdmin || false,
          kycStatus: user.kycStatus || 'not_submitted',
          walletAddress: user.walletAddress,
          nftTokenId: user.nftTokenId,
          nftChain: user.nftChain,
          residentialArea: user.residentialArea,
        }
      }
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Google authentication failed', data: null });
  }
});

// Get Current User
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
    if (!user) {
      return res.status(404).json({ code: 'ERROR', msg: 'User not found', data: null });
    }
    
    res.json({
      code: 'SUCCESS',
      msg: 'User found',
      data: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        isEmailVerified: user.isEmailVerified,
        isAdmin: user.isAdmin,
        kycStatus: user.kycStatus,
        walletAddress: user.walletAddress,
        nftTokenId: user.nftTokenId,
        nftChain: user.nftChain,
        residentialArea: user.residentialArea,
      }
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// ============================================
// KYC Routes
// ============================================

// Extract ID Card Data using Azure Form Recognizer
app.post('/api/kyc/extract-id', authenticateToken, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    
    if (!imageBase64) {
      return res.status(400).json({ code: 'ERROR', msg: 'Image data is required', data: null });
    }

    console.log('Starting Azure Form Recognizer extraction...');
    
    // Use Azure Form Recognizer to extract ID card data
    const azureResult = await extractWithAzure(imageBase64);
    
    if (!azureResult.success) {
      console.error('Azure extraction failed:', azureResult.error);
      return res.status(500).json({ 
        code: 'ERROR', 
        msg: 'Failed to extract ID card data: ' + azureResult.error, 
        data: null 
      });
    }

    const extractedData = azureResult.data;
    console.log('Azure extraction successful:', extractedData);

    // Validate NID number format
    const nidNumber = extractedData.idNumber?.replace(/[\s-]/g, '') || '';
    const isValidNID = /^\d{10}$|^\d{13}$|^\d{17}$/.test(nidNumber);

    res.json({
      code: 'SUCCESS',
      msg: 'ID card data extracted successfully using Azure Form Recognizer',
      data: {
        name: extractedData.name,
        nameBangla: extractedData.nameBangla,
        fatherName: extractedData.fatherName,
        motherName: extractedData.motherName,
        dateOfBirth: extractedData.dateOfBirth,
        idNumber: nidNumber,
        address: extractedData.address,
        confidence: extractedData.confidence,
        extractionStatus: extractedData.extractionStatus,
        errors: extractedData.errors
      }
    });

  } catch (error) {
    console.error('ID extraction error:', error);
    res.status(500).json({ 
      code: 'ERROR', 
      msg: 'Failed to extract ID card data: ' + error.message, 
      data: null 
    });
  }
});

// Check for duplicate NID
app.post('/api/kyc/check-duplicate-nid', authenticateToken, async (req, res) => {
  try {
    const { nidNumber } = req.body;
    const userId = req.user.userId;
    
    if (!nidNumber) {
      return res.status(400).json({ code: 'ERROR', msg: 'NID number is required', data: null });
    }

    // Clean the NID number
    const cleanNID = nidNumber.replace(/[\s-]/g, '');
    
    // Check if NID exists in approved KYC requests (excluding current user's rejected requests)
    const existingKYC = await db.collection('kyc_requests').findOne({
      nidNumber: cleanNID,
      status: { $in: ['pending', 'approved'] },
      userId: { $ne: userId }
    });
    
    if (existingKYC) {
      return res.json({
        code: 'SUCCESS',
        msg: 'Duplicate check completed',
        data: { 
          isDuplicate: true, 
          message: 'This NID number is already registered in the system'
        }
      });
    }

    res.json({
      code: 'SUCCESS', 
      msg: 'Duplicate check completed',
      data: { isDuplicate: false }
    });

  } catch (error) {
    console.error('Duplicate NID check error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Verify face match between ID card and selfie
app.post('/api/kyc/verify-face', authenticateToken, async (req, res) => {
  try {
    const { idCardImage, selfieImage } = req.body;
    
    if (!idCardImage || !selfieImage) {
      return res.status(400).json({ 
        code: 'ERROR', 
        msg: 'Both ID card image and selfie image are required', 
        data: null 
      });
    }

    // Check if Face verification is available
    if (!isFaceVerificationAvailable()) {
      return res.json({
        code: 'SUCCESS',
        msg: 'Face verification skipped - service not available',
        data: {
          skipped: true,
          message: 'Face verification is not available.'
        }
      });
    }

    console.log('Starting face verification between ID card and selfie...');
    
    const result = await compareFaces(idCardImage, selfieImage);
    
    if (!result.success) {
      return res.status(400).json({
        code: 'ERROR',
        msg: result.error,
        data: {
          step: result.step,
          skipped: result.skipped || false
        }
      });
    }

    res.json({
      code: 'SUCCESS',
      msg: result.message,
      data: {
        isMatch: result.isMatch,
        confidence: result.confidence,
        confidencePercent: result.confidencePercent
      }
    });

  } catch (error) {
    console.error('Face verification error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Face verification failed: ' + error.message, data: null });
  }
});

// Submit KYC
app.post('/api/kyc/submit', authenticateToken, async (req, res) => {
  try {
    const { fullName, residentialArea, idCardFront, idCardBack, facePhoto, walletAddress, chainType, extractedData } = req.body;
    const userId = req.user.userId;
    
    // Check if user already has pending/approved KYC
    const existingKYC = await db.collection('kyc_requests').findOne({
      userId,
      status: { $in: ['pending', 'approved'] }
    });
    
    if (existingKYC) {
      return res.status(400).json({ 
        code: 'ERROR', 
        msg: existingKYC.status === 'approved' ? 'KYC already approved' : 'KYC request already pending',
        data: null 
      });
    }

    // Check for duplicate NID if extractedData contains NID number
    if (extractedData?.nidNumber) {
      const cleanNID = extractedData.nidNumber.replace(/[\s-]/g, '');
      const duplicateNID = await db.collection('kyc_requests').findOne({
        nidNumber: cleanNID,
        status: { $in: ['pending', 'approved'] },
        userId: { $ne: userId }
      });
      
      if (duplicateNID) {
        return res.status(400).json({ 
          code: 'ERROR', 
          msg: 'This NID number is already registered in the system',
          data: null 
        });
      }
    }
    
    const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

    // Helper to check if string is a URL
    const isUrl = (str) => str && (str.startsWith('http://') || str.startsWith('https://'));

    // Use Cloudinary URLs directly if already uploaded from client
    // Otherwise upload base64 images (fallback for backward compatibility)
    let idCardFrontUrl = null;
    let idCardBackUrl = null;
    let facePhotoUrl = null;

    if (idCardFront) {
      if (isUrl(idCardFront)) {
        idCardFrontUrl = idCardFront;
      } else {
        const frontUpload = await uploadToCloudinary(idCardFront, 'kyc/id-front');
        idCardFrontUrl = frontUpload.success ? frontUpload.url : null;
      }
    }

    if (idCardBack) {
      if (isUrl(idCardBack)) {
        idCardBackUrl = idCardBack;
      } else {
        const backUpload = await uploadToCloudinary(idCardBack, 'kyc/id-back');
        idCardBackUrl = backUpload.success ? backUpload.url : null;
      }
    }

    if (facePhoto) {
      if (isUrl(facePhoto)) {
        facePhotoUrl = facePhoto;
      } else {
        const faceUpload = await uploadToCloudinary(facePhoto, 'kyc/face');
        facePhotoUrl = faceUpload.success ? faceUpload.url : null;
      }
    }

    console.log('Image URLs:', { idCardFrontUrl, idCardBackUrl, facePhotoUrl });
    
    const kycRequest = {
      userId,
      userEmail: user.email,
      userName: fullName,
      idCardFront: idCardFrontUrl,
      idCardBack: idCardBackUrl,
      facePhoto: facePhotoUrl,
      walletAddress,
      chainType,
      residentialArea,
      status: 'pending',
      submittedAt: new Date(),
      // Store extracted data for verification
      nidNumber: extractedData?.nidNumber?.replace(/[\s-]/g, '') || null,
      extractedData: extractedData || null,
    };
    
    const result = await db.collection('kyc_requests').insertOne(kycRequest);
    
    // Update user KYC status
    await db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { kycStatus: 'pending', updatedAt: new Date() } }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'KYC submitted successfully',
      data: { requestId: result.insertedId.toString() }
    });
  } catch (error) {
    console.error('KYC submit error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Get KYC Status
app.get('/api/kyc/status', authenticateToken, async (req, res) => {
  try {
    const kycRequest = await db.collection('kyc_requests').findOne(
      { userId: req.user.userId },
      { sort: { submittedAt: -1 } }
    );
    
    if (!kycRequest) {
      return res.json({ code: 'SUCCESS', msg: 'No KYC request found', data: null });
    }
    
    res.json({
      code: 'SUCCESS',
      msg: 'KYC status retrieved',
      data: {
        id: kycRequest._id.toString(),
        ...kycRequest,
        _id: undefined
      }
    });
  } catch (error) {
    console.error('Get KYC status error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Get All KYC Requests (Admin)
app.get('/api/kyc/requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    
    const requests = await db.collection('kyc_requests')
      .find(filter)
      .sort({ submittedAt: -1 })
      .toArray();
    
    res.json({
      code: 'SUCCESS',
      msg: 'KYC requests retrieved',
      data: requests.map(r => ({ id: r._id.toString(), ...r, _id: undefined }))
    });
  } catch (error) {
    console.error('Get KYC requests error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Get Single KYC Request (Admin)
app.get('/api/kyc/requests/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const request = await db.collection('kyc_requests').findOne({ _id: new ObjectId(req.params.id) });
    
    if (!request) {
      return res.status(404).json({ code: 'ERROR', msg: 'KYC request not found', data: null });
    }
    
    res.json({
      code: 'SUCCESS',
      msg: 'KYC request retrieved',
      data: { id: request._id.toString(), ...request, _id: undefined }
    });
  } catch (error) {
    console.error('Get KYC request error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Approve KYC (Admin) - Mints NFT on blockchain
app.post('/api/kyc/requests/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('\n========================================');
    console.log('KYC APPROVE REQUEST STARTED');
    console.log('Request ID from URL:', req.params.id);
    console.log('========================================');
    
    const request = await db.collection('kyc_requests').findOne({ _id: new ObjectId(req.params.id) });
    
    if (!request) {
      console.log('ERROR: KYC request not found for ID:', req.params.id);
      return res.status(404).json({ code: 'ERROR', msg: 'KYC request not found', data: null });
    }
    
    // Log the FULL request from database
    console.log('\n=== FULL KYC REQUEST FROM DATABASE ===');
    console.log('_id:', request._id.toString());
    console.log('userId:', request.userId);
    console.log('userName:', request.userName);
    console.log('userEmail:', request.userEmail);
    console.log('walletAddress:', request.walletAddress);
    console.log('status:', request.status);
    console.log('nidNumber (top level):', request.nidNumber);
    console.log('extractedData:', JSON.stringify(request.extractedData, null, 2));
    console.log('=======================================\n');
    
    if (request.status !== 'pending') {
      console.log('ERROR: KYC request already processed, status:', request.status);
      return res.status(400).json({ code: 'ERROR', msg: 'KYC request already processed', data: null });
    }
    
    // Get the actual NID number - this is the UNIQUE identifier
    // DEBUG: Log all NID sources
    console.log('=== DEBUG NID SOURCES ===');
    console.log('request.nidNumber:', request.nidNumber);
    console.log('request.extractedData?.nidNumber:', request.extractedData?.nidNumber);
    console.log('Full extractedData:', JSON.stringify(request.extractedData, null, 2));
    
    const actualNID = request.nidNumber || request.extractedData?.nidNumber;
    console.log('actualNID being used:', actualNID);
    console.log('=========================');
    
    if (!actualNID) {
      return res.status(400).json({ 
        code: 'ERROR', 
        msg: 'NID number not found in KYC request. Cannot mint NFT without valid NID.', 
        data: null 
      });
    }
    
    // Pre-check: Verify NID is not already registered on blockchain
    try {
      console.log(`Checking if NID "${actualNID}" is registered on blockchain...`);
      const isNIDUsed = await voterNFTContract.isNIDRegistered(actualNID);
      console.log(`isNIDRegistered("${actualNID}") = ${isNIDUsed}`);
      
      if (isNIDUsed) {
        return res.status(400).json({ 
          code: 'ERROR', 
          msg: `NID ${actualNID} is already registered on the blockchain. Each NID can only be used once.`, 
          data: { nidNumber: actualNID, alreadyRegistered: true }
        });
      }
      
      console.log(`Checking if wallet "${request.walletAddress}" is registered...`);
      const isWalletRegistered = await voterNFTContract.isRegistered(request.walletAddress);
      console.log(`isRegistered("${request.walletAddress}") = ${isWalletRegistered}`);
      
      if (isWalletRegistered) {
        return res.status(400).json({ 
          code: 'ERROR', 
          msg: `Wallet ${request.walletAddress} already has a Voter NFT. Each wallet can only have one NFT.`, 
          data: { walletAddress: request.walletAddress, alreadyRegistered: true }
        });
      }
      
      console.log(`Pre-check passed: NID ${actualNID} and wallet ${request.walletAddress} are available`);
    } catch (preCheckError) {
      console.error('Pre-check error:', preCheckError);
      console.error('Pre-check error message:', preCheckError.message);
      // DON'T continue - if pre-check fails, we should stop
      return res.status(500).json({ 
        code: 'ERROR', 
        msg: 'Failed to verify NID/wallet availability: ' + preCheckError.message, 
        data: null 
      });
    }
    
    // Extract data from the request - use extracted data if available
    const extractedData = request.extractedData || {};
    const userName = extractedData.name || request.userName;
    // Clean name - remove Bengali text if present, keep only English
    const cleanName = userName.includes('\n') 
      ? userName.split('\n').find(part => /^[A-Z\s.]+$/.test(part.trim())) || userName.split('\n').pop()
      : userName;
    
    // Create NFT metadata object
    const nftMetadata = {
      name: `Voter Identity NFT #${actualNID.slice(-4)}`,
      description: `Verified Voter Identity NFT for ${cleanName}`,
      image: request.facePhoto || 'https://res.cloudinary.com/dq9yrj7c9/image/upload/v1/kyc/default-voter.png',
      external_url: `https://voternft.app/voter/${actualNID}`,
      attributes: [
        { trait_type: 'Full Name', value: cleanName },
        { trait_type: 'Father Name', value: extractedData.fatherName || 'Not Provided' },
        { trait_type: 'Mother Name', value: extractedData.motherName || 'Not Provided' },
        { trait_type: 'Date of Birth', value: extractedData.dateOfBirth || 'Not Provided' },
        { trait_type: 'NID Number', value: actualNID },
        { trait_type: 'Residential Area', value: request.residentialArea },
        { trait_type: 'Verification Date', value: new Date().toISOString().split('T')[0] },
        { trait_type: 'Chain', value: request.chainType || 'BNB' }
      ]
    };
    
    // Upload metadata to Cloudinary as JSON (alternative to IPFS)
    let metadataUrl;
    try {
      const metadataJson = JSON.stringify(nftMetadata);
      const metadataBase64 = Buffer.from(metadataJson).toString('base64');
      const metadataUpload = await cloudinary.uploader.upload(
        `data:application/json;base64,${metadataBase64}`,
        {
          folder: 'kyc/metadata',
          public_id: `voter_${actualNID}`,
          resource_type: 'raw'
        }
      );
      metadataUrl = metadataUpload.secure_url;
      console.log('Metadata uploaded to:', metadataUrl);
    } catch (uploadError) {
      console.error('Metadata upload error:', uploadError);
      // Fallback: use a data URI or empty string
      metadataUrl = '';
    }
    
    // Mint NFT on blockchain with actual data
    const voterInfo = {
      name: cleanName,
      fatherName: extractedData.fatherName || 'Not Provided',
      motherName: extractedData.motherName || 'Not Provided',
      dateOfBirth: extractedData.dateOfBirth || 'Not Provided',
      nidNumber: actualNID,  // Use the ACTUAL NID number as unique identifier
      residentialArea: request.residentialArea,
      ipfsMetadataHash: metadataUrl || `https://voternft.app/api/metadata/${actualNID}`
    };
    
    console.log('\n========================================');
    console.log('MINTING NFT - FINAL DATA BEING SENT');
    console.log('========================================');
    console.log('Wallet Address:', request.walletAddress);
    console.log('voterInfo.name:', voterInfo.name);
    console.log('voterInfo.fatherName:', voterInfo.fatherName);
    console.log('voterInfo.motherName:', voterInfo.motherName);
    console.log('voterInfo.dateOfBirth:', voterInfo.dateOfBirth);
    console.log('voterInfo.nidNumber:', voterInfo.nidNumber);
    console.log('voterInfo.residentialArea:', voterInfo.residentialArea);
    console.log('voterInfo.ipfsMetadataHash:', voterInfo.ipfsMetadataHash);
    console.log('========================================\n');
    
    let nftTokenId, transactionHash;
    
    try {
      console.log('Calling voterNFTContract.mintVoterNFT...');
      const tx = await voterNFTContract.mintVoterNFT(request.walletAddress, voterInfo);
      const receipt = await tx.wait();
      transactionHash = receipt.hash;
      
      // Get token ID from event
      const event = receipt.logs.find(log => {
        try {
          const parsed = voterNFTContract.interface.parseLog(log);
          return parsed.name === 'VoterRegistered';
        } catch { return false; }
      });
      
      if (event) {
        const parsed = voterNFTContract.interface.parseLog(event);
        nftTokenId = parsed.args.tokenId.toString();
      } else {
        nftTokenId = `NFT-${Date.now()}`;
      }
    } catch (blockchainError) {
      console.error('Blockchain error:', blockchainError);
      return res.status(500).json({ 
        code: 'ERROR', 
        msg: 'Failed to mint NFT: ' + blockchainError.message, 
        data: null 
      });
    }
    
    // Update KYC request
    await db.collection('kyc_requests').updateOne(
      { _id: request._id },
      {
        $set: {
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: req.user.userId,
          nftTokenId,
          nftTransactionHash: transactionHash
        }
      }
    );
    
    // Update user
    await db.collection('users').updateOne(
      { _id: new ObjectId(request.userId) },
      {
        $set: {
          kycStatus: 'approved',
          walletAddress: request.walletAddress,
          nftTokenId,
          nftChain: request.chainType,
          residentialArea: request.residentialArea,
          updatedAt: new Date()
        }
      }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'KYC approved and NFT minted',
      data: { nftTokenId, transactionHash }
    });
  } catch (error) {
    console.error('Approve KYC error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Approve KYC with wallet transaction (Admin) - No server-side minting, just record tx
app.post('/api/kyc/requests/:id/approve-with-tx', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ipfsHash, txHash } = req.body;
    const request = await db.collection('kyc_requests').findOne({ _id: new ObjectId(req.params.id) });
    
    if (!request) {
      return res.status(404).json({ code: 'ERROR', msg: 'KYC request not found', data: null });
    }
    
    if (request.status !== 'pending') {
      return res.status(400).json({ code: 'ERROR', msg: 'KYC request already processed', data: null });
    }
    
    // Generate token ID from transaction hash
    const nftTokenId = `NFT-${txHash.slice(2, 10).toUpperCase()}`;
    
    // Update KYC request
    await db.collection('kyc_requests').updateOne(
      { _id: request._id },
      {
        $set: {
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: req.user.userId,
          nftTokenId,
          nftTransactionHash: txHash,
          ipfsMetadataHash: ipfsHash
        }
      }
    );
    
    // Update user
    await db.collection('users').updateOne(
      { _id: new ObjectId(request.userId) },
      {
        $set: {
          kycStatus: 'approved',
          nftTokenId,
          nftTransactionHash: txHash,
          nftChain: request.chainType,
          residentialArea: request.residentialArea,
          updatedAt: new Date()
        }
      }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'KYC approved with wallet transaction',
      data: { nftTokenId, transactionHash: txHash }
    });
  } catch (error) {
    console.error('Approve KYC with tx error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Admin: Check NFT details on blockchain (for debugging)
app.get('/api/admin/nft-check/:nidOrTokenId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { nidOrTokenId } = req.params;
    const results = {};
    
    // Check if it's a NID number
    try {
      const isNIDUsed = await voterNFTContract.isNIDRegistered(nidOrTokenId);
      results.nidCheck = { nid: nidOrTokenId, isRegistered: isNIDUsed };
    } catch (e) {
      results.nidCheck = { error: e.message };
    }
    
    // If it looks like a token ID (number), get the tokenURI
    if (/^\d+$/.test(nidOrTokenId)) {
      try {
        const tokenURI = await voterNFTContract.tokenURI(nidOrTokenId);
        results.tokenURI = tokenURI;
      } catch (e) {
        results.tokenURI = { error: e.message };
      }
    }
    
    // Check total registered voters
    try {
      const totalVoters = await voterNFTContract.totalRegisteredVoters();
      results.totalRegisteredVoters = totalVoters.toString();
    } catch (e) {
      results.totalRegisteredVoters = { error: e.message };
    }
    
    // Check database records
    const dbRecord = await db.collection('kyc_requests').findOne({
      $or: [
        { nidNumber: nidOrTokenId },
        { nftTokenId: nidOrTokenId },
        { 'extractedData.nidNumber': nidOrTokenId }
      ]
    });
    results.databaseRecord = dbRecord ? {
      id: dbRecord._id,
      nidNumber: dbRecord.nidNumber,
      status: dbRecord.status,
      nftTokenId: dbRecord.nftTokenId,
      walletAddress: dbRecord.walletAddress
    } : null;
    
    res.json({ code: 'SUCCESS', data: results });
  } catch (error) {
    console.error('NFT check error:', error);
    res.status(500).json({ code: 'ERROR', msg: error.message });
  }
});

// NFT Metadata API endpoint - serves metadata for marketplaces (OpenSea, BscScan, etc.)
app.get('/api/metadata/:nidOrTokenId', async (req, res) => {
  try {
    const { nidOrTokenId } = req.params;
    
    // Try to find by NID number first, then by token ID
    let kycRequest = await db.collection('kyc_requests').findOne({
      $or: [
        { nidNumber: nidOrTokenId },
        { nftTokenId: nidOrTokenId },
        { 'extractedData.nidNumber': nidOrTokenId }
      ],
      status: 'approved'
    });
    
    if (!kycRequest) {
      return res.status(404).json({ error: 'NFT not found' });
    }
    
    const extractedData = kycRequest.extractedData || {};
    const userName = extractedData.name || kycRequest.userName;
    // Clean name - remove Bengali text if present
    const cleanName = userName.includes('\n') 
      ? userName.split('\n').find(part => /^[A-Z\s.]+$/.test(part.trim())) || userName.split('\n').pop()
      : userName;
    
    const nidNumber = kycRequest.nidNumber || extractedData.nidNumber;
    
    // Return OpenSea-compatible metadata
    const metadata = {
      name: `Voter Identity NFT #${nidNumber ? nidNumber.slice(-4) : kycRequest.nftTokenId}`,
      description: `Verified Voter Identity NFT for ${cleanName}. This NFT represents a verified voter identity in the decentralized voting system.`,
      image: kycRequest.facePhoto || 'https://res.cloudinary.com/dq9yrj7c9/image/upload/v1/kyc/default-voter.png',
      external_url: `https://voternft.app/voter/${nidNumber || kycRequest.nftTokenId}`,
      attributes: [
        { trait_type: 'Full Name', value: cleanName || 'Not Provided' },
        { trait_type: 'Father Name', value: extractedData.fatherName || 'Not Provided' },
        { trait_type: 'Mother Name', value: extractedData.motherName || 'Not Provided' },
        { trait_type: 'Date of Birth', value: extractedData.dateOfBirth || 'Not Provided' },
        { trait_type: 'NID Number', value: nidNumber || 'Not Provided' },
        { trait_type: 'Residential Area', value: kycRequest.residentialArea || 'Not Provided' },
        { trait_type: 'Verification Status', value: 'Verified' },
        { trait_type: 'Chain', value: kycRequest.chainType || 'BNB' },
        { trait_type: 'Token ID', value: kycRequest.nftTokenId || 'N/A' }
      ]
    };
    
    // Set proper headers for NFT metadata
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(metadata);
  } catch (error) {
    console.error('Metadata fetch error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject KYC (Admin)
app.post('/api/kyc/requests/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const request = await db.collection('kyc_requests').findOne({ _id: new ObjectId(req.params.id) });
    
    if (!request) {
      return res.status(404).json({ code: 'ERROR', msg: 'KYC request not found' });
    }
    
    await db.collection('kyc_requests').updateOne(
      { _id: request._id },
      {
        $set: {
          status: 'rejected',
          reviewedAt: new Date(),
          reviewedBy: req.user.userId,
          rejectionReason: reason
        }
      }
    );
    
    await db.collection('users').updateOne(
      { _id: new ObjectId(request.userId) },
      { $set: { kycStatus: 'rejected', updatedAt: new Date() } }
    );
    
    res.json({ code: 'SUCCESS', msg: 'KYC rejected' });
  } catch (error) {
    console.error('Reject KYC error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error' });
  }
});

// ============================================
// Voting Routes
// ============================================

// Create Voting (Admin)
app.post('/api/voting/create', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, description, candidates, startTime, endTime, votingArea, eligibleAreas, chainType } = req.body;
    
    // Validate timestamps
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    
    console.log('Create voting request:', { title, startTime, endTime, startDate, endDate });
    
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ 
        code: 'ERROR', 
        msg: 'Invalid date format for startTime or endTime', 
        data: null 
      });
    }
    
    if (startDate >= endDate) {
      return res.status(400).json({ 
        code: 'ERROR', 
        msg: 'Start time must be before end time', 
        data: null 
      });
    }
    
    let blockchainElectionId;
    
    try {
      // Create election on blockchain
      const startTimestamp = Math.floor(startDate.getTime() / 1000);
      const endTimestamp = Math.floor(endDate.getTime() / 1000);
      
      console.log('Blockchain timestamps:', { startTimestamp, endTimestamp });
      
      const tx = await votingSystemContract.createElection(
        title,
        description,
        startTimestamp,
        endTimestamp,
        eligibleAreas
      );
      const receipt = await tx.wait();
      
      // Get election ID from event
      const event = receipt.logs.find(log => {
        try {
          const parsed = votingSystemContract.interface.parseLog(log);
          return parsed.name === 'ElectionCreated';
        } catch { return false; }
      });
      
      if (event) {
        const parsed = votingSystemContract.interface.parseLog(event);
        blockchainElectionId = parsed.args.electionId.toString();
      }
      
      // Add candidates to blockchain
      for (const candidate of candidates) {
        const candidateTx = await votingSystemContract.addCandidate(
          blockchainElectionId,
          candidate.name,
          candidate.party,
          candidate.description
        );
        await candidateTx.wait();
      }
    } catch (blockchainError) {
      console.error('Blockchain error:', blockchainError);
      return res.status(500).json({ 
        code: 'ERROR', 
        msg: 'Failed to create election on blockchain: ' + blockchainError.message, 
        data: null 
      });
    }
    
    // Save to database
    const voting = {
      blockchainElectionId,
      title,
      description,
      candidates: candidates.map((c, idx) => ({
        id: (idx + 1).toString(),
        blockchainId: (idx + 1).toString(),
        name: c.name,
        party: c.party,
        description: c.description,
        photo: c.photo,
        voteCount: 0
      })),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      votingArea,
      eligibleAreas,
      chainType,
      status: new Date() < new Date(startTime) ? 'upcoming' : 'active',
      createdBy: req.user.userId,
      createdAt: new Date(),
      totalVotes: 0
    };
    
    const result = await db.collection('votings').insertOne(voting);
    
    res.json({
      code: 'SUCCESS',
      msg: 'Voting created successfully',
      data: { votingId: result.insertedId.toString() }
    });
  } catch (error) {
    console.error('Create voting error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Get All Votings
app.get('/api/voting', async (req, res) => {
  try {
    const { status } = req.query;
    
    // Update statuses based on current time
    const now = new Date();
    await db.collection('votings').updateMany(
      { startTime: { $lte: now }, endTime: { $gt: now }, status: 'upcoming' },
      { $set: { status: 'active' } }
    );
    await db.collection('votings').updateMany(
      { endTime: { $lte: now }, status: { $in: ['upcoming', 'active'] } },
      { $set: { status: 'completed' } }
    );
    
    const filter = status ? { status } : {};
    const votings = await db.collection('votings').find(filter).sort({ createdAt: -1 }).toArray();
    
    res.json({
      code: 'SUCCESS',
      msg: 'Votings retrieved',
      data: votings.map(v => ({
        id: v._id.toString(),
        ...v,
        _id: undefined,
        startTime: v.startTime.toISOString(),
        endTime: v.endTime.toISOString(),
        createdAt: v.createdAt.toISOString()
      }))
    });
  } catch (error) {
    console.error('Get votings error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Get My Votes (must be before :id route)
app.get('/api/voting/my-votes', authenticateToken, async (req, res) => {
  try {
    // Query both voterId and oderId for backward compatibility
    const votes = await db.collection('votes')
      .find({ 
        $or: [
          { voterId: req.user.userId },
          { oderId: req.user.userId }
        ]
      })
      .sort({ timestamp: -1 })
      .toArray();
    
    // Auto-migrate any votes with oderId to voterId
    const votesToMigrate = votes.filter(v => v.oderId && !v.voterId);
    if (votesToMigrate.length > 0) {
      await db.collection('votes').updateMany(
        { _id: { $in: votesToMigrate.map(v => v._id) } },
        [
          { $set: { voterId: "$oderId" } },
          { $unset: "oderId" }
        ]
      );
      console.log(`Auto-migrated ${votesToMigrate.length} votes from oderId to voterId`);
    }
    
    // Get voting titles
    const votingIds = [...new Set(votes.map(v => v.votingId))];
    let votingMap = {};
    if (votingIds.length > 0) {
      const votings = await db.collection('votings')
        .find({ _id: { $in: votingIds.map(id => new ObjectId(id)) } })
        .toArray();
      votingMap = Object.fromEntries(votings.map(v => [v._id.toString(), v.title]));
    }
    
    res.json({
      code: 'SUCCESS',
      msg: 'Votes retrieved',
      data: votes.map(v => ({
        id: v._id.toString(),
        votingId: v.votingId,
        votingTitle: votingMap[v.votingId] || 'Unknown',
        candidateName: v.candidateName,
        candidateParty: v.candidateParty,
        timestamp: v.timestamp.toISOString(),
        transactionHash: v.transactionHash,
        blockNumber: v.blockNumber,
        chainType: v.chainType,
        status: v.status
      }))
    });
  } catch (error) {
    console.error('Get my votes error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Get Single Voting
app.get('/api/voting/:id', async (req, res) => {
  try {
    const voting = await db.collection('votings').findOne({ _id: new ObjectId(req.params.id) });
    
    if (!voting) {
      return res.status(404).json({ code: 'ERROR', msg: 'Voting not found', data: null });
    }
    
    res.json({
      code: 'SUCCESS',
      msg: 'Voting retrieved',
      data: {
        id: voting._id.toString(),
        ...voting,
        _id: undefined,
        startTime: voting.startTime.toISOString(),
        endTime: voting.endTime.toISOString(),
        createdAt: voting.createdAt.toISOString()
      }
    });
  } catch (error) {
    console.error('Get voting error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Cast Vote
app.post('/api/voting/:id/vote', authenticateToken, async (req, res) => {
  try {
    const { candidateId } = req.body;
    const votingId = req.params.id;
    const userId = req.user.userId;
    
    // Get user
    const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user || user.kycStatus !== 'approved') {
      return res.status(403).json({ code: 'ERROR', msg: 'KYC verification required to vote', data: null });
    }
    
    // Get voting
    const voting = await db.collection('votings').findOne({ _id: new ObjectId(votingId) });
    if (!voting) {
      return res.status(404).json({ code: 'ERROR', msg: 'Voting not found', data: null });
    }
    
    if (voting.status !== 'active') {
      return res.status(400).json({ code: 'ERROR', msg: 'Voting is not active', data: null });
    }
    
    // Check if user's area is eligible
    if (!voting.eligibleAreas.includes(user.residentialArea)) {
      return res.status(403).json({ code: 'ERROR', msg: 'You are not eligible to vote in this election', data: null });
    }
    
    // Check if already voted
    const existingVote = await db.collection('votes').findOne({ votingId, oderId: userId });
    if (existingVote) {
      return res.status(400).json({ code: 'ERROR', msg: 'You have already voted', data: null });
    }
    
    let transactionHash, blockNumber;
    
    try {
      // Cast vote on blockchain
      const tx = await votingSystemContract.castVote(voting.blockchainElectionId, candidateId);
      const receipt = await tx.wait();
      transactionHash = receipt.hash;
      blockNumber = receipt.blockNumber;
    } catch (blockchainError) {
      console.error('Blockchain vote error:', blockchainError);
      return res.status(500).json({ 
        code: 'ERROR', 
        msg: 'Failed to cast vote on blockchain: ' + blockchainError.message, 
        data: null 
      });
    }
    
    // Save vote to database
    const candidate = voting.candidates.find(c => c.id === candidateId);
    const vote = {
      votingId,
      voterId: userId,
      candidateId,
      candidateName: candidate?.name,
      candidateParty: candidate?.party,
      walletAddress: user.walletAddress,
      transactionHash,
      blockNumber,
      chainType: voting.chainType,
      timestamp: new Date(),
      status: 'confirmed'
    };
    
    await db.collection('votes').insertOne(vote);
    
    // Update vote count
    await db.collection('votings').updateOne(
      { _id: voting._id, 'candidates.id': candidateId },
      { 
        $inc: { totalVotes: 1, 'candidates.$.voteCount': 1 }
      }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'Vote cast successfully',
      data: { transactionHash, blockNumber }
    });
  } catch (error) {
    console.error('Cast vote error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Create Voting with Wallet Transaction (Admin) - No server-side blockchain call
app.post('/api/voting/create-with-tx', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, description, candidates, startTime, endTime, votingArea, eligibleAreas, chainType, txHash, blockchainElectionId } = req.body;
    
    // Save to database
    const voting = {
      blockchainElectionId: blockchainElectionId || `ELECTION-${txHash.slice(2, 10).toUpperCase()}`,
      title,
      description,
      candidates: candidates.map((c, idx) => ({
        id: (idx + 1).toString(),
        blockchainId: (idx + 1).toString(),
        name: c.name,
        party: c.party,
        description: c.description,
        photo: c.photo,
        voteCount: 0
      })),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      votingArea,
      eligibleAreas,
      chainType,
      status: new Date() < new Date(startTime) ? 'upcoming' : 'active',
      createdBy: req.user.userId,
      createdAt: new Date(),
      totalVotes: 0,
      transactionHash: txHash
    };
    
    const result = await db.collection('votings').insertOne(voting);
    
    res.json({
      code: 'SUCCESS',
      msg: 'Voting created successfully with wallet transaction',
      data: { votingId: result.insertedId.toString() }
    });
  } catch (error) {
    console.error('Create voting with tx error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Cast Vote with Wallet Transaction - No server-side blockchain call
app.post('/api/voting/:id/vote-with-tx', authenticateToken, async (req, res) => {
  try {
    const { candidateId, txHash, blockNumber } = req.body;
    const votingId = req.params.id;
    const userId = req.user.userId;
    
    // Get user
    const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user || user.kycStatus !== 'approved') {
      return res.status(403).json({ code: 'ERROR', msg: 'KYC verification required to vote', data: null });
    }
    
    // Get voting
    const voting = await db.collection('votings').findOne({ _id: new ObjectId(votingId) });
    if (!voting) {
      return res.status(404).json({ code: 'ERROR', msg: 'Voting not found', data: null });
    }
    
    if (voting.status !== 'active') {
      return res.status(400).json({ code: 'ERROR', msg: 'Voting is not active', data: null });
    }
    
    // Check if user's area is eligible
    if (!voting.eligibleAreas.includes(user.residentialArea)) {
      return res.status(403).json({ code: 'ERROR', msg: 'You are not eligible to vote in this election', data: null });
    }
    
    // Note: Duplicate vote checking is now handled by the blockchain using NFT token ID
    // The smart contract tracks hasVotedByTokenId[tokenId] to prevent the same NFT from voting twice
    // This prevents vote duplication even if the NFT is transferred to another wallet
    
    // Save vote to database for record-keeping (blockchain is source of truth)
    const candidate = voting.candidates.find(c => c.id === candidateId);
    const vote = {
      votingId,
      voterId: userId,
      candidateId,
      candidateName: candidate?.name,
      candidateParty: candidate?.party,
      walletAddress: user.walletAddress,
      transactionHash: txHash,
      blockNumber: blockNumber || 0,
      chainType: voting.chainType,
      timestamp: new Date(),
      status: 'confirmed'
    };
    
    await db.collection('votes').insertOne(vote);
    
    // Update vote count
    await db.collection('votings').updateOne(
      { _id: voting._id, 'candidates.id': candidateId },
      { 
        $inc: { totalVotes: 1, 'candidates.$.voteCount': 1 }
      }
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'Vote recorded successfully',
      data: { transactionHash: txHash, blockNumber: blockNumber || 0 }
    });
  } catch (error) {
    console.error('Cast vote with tx error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Migrate votes from oderId to voterId (one-time fix)
app.post('/api/voting/migrate-votes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await db.collection('votes').updateMany(
      { oderId: { $exists: true } },
      [
        { $set: { voterId: "$oderId" } },
        { $unset: "oderId" }
      ]
    );
    
    res.json({
      code: 'SUCCESS',
      msg: 'Votes migrated successfully',
      data: { 
        matched: result.matchedCount, 
        modified: result.modifiedCount 
      }
    });
  } catch (error) {
    console.error('Migrate votes error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// ============================================
// User Routes
// ============================================

// Get Verified Voters (Admin)
app.get('/api/users/voters', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const voters = await db.collection('users')
      .find({ kycStatus: 'approved' })
      .toArray();
    
    // Get vote counts
    const voterIds = voters.map(v => v._id.toString());
    const voteCounts = await db.collection('votes')
      .aggregate([
        { $match: { voterId: { $in: voterIds } } },
        { $group: { _id: '$voterId', count: { $sum: 1 } } }
      ])
      .toArray();
    const voteCountMap = Object.fromEntries(voteCounts.map(v => [v._id, v.count]));
    
    // Get KYC request data for ipfsMetadataHash (stored in kyc_requests collection)
    const kycRequests = await db.collection('kyc_requests')
      .find({ userId: { $in: voterIds }, status: 'approved' })
      .toArray();
    const kycDataMap = Object.fromEntries(kycRequests.map(k => [k.userId, k]));
    
    res.json({
      code: 'SUCCESS',
      msg: 'Voters retrieved',
      data: voters.map(v => {
        const kycData = kycDataMap[v._id.toString()];
        return {
          id: v._id.toString(),
          name: v.name,
          email: v.email,
          walletAddress: v.walletAddress || kycData?.walletAddress,
          chainType: v.nftChain || kycData?.chainType,
          nftTokenId: v.nftTokenId || kycData?.nftTokenId,
          nftTransactionHash: v.nftTransactionHash || kycData?.nftTransactionHash,
          ipfsMetadataHash: v.ipfsMetadataHash || kycData?.ipfsMetadataHash,
          verifiedAt: v.updatedAt?.toISOString() || kycData?.reviewedAt?.toISOString(),
          area: v.residentialArea || kycData?.residentialArea,
          totalVotes: voteCountMap[v._id.toString()] || 0
        };
      })
    });
  } catch (error) {
    console.error('Get voters error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// Get Stats (Admin)
app.get('/api/users/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [totalUsers, verifiedVoters, pendingKYC, activeVotings, completedVotings, totalVotesCast] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('users').countDocuments({ kycStatus: 'approved' }),
      db.collection('kyc_requests').countDocuments({ status: 'pending' }),
      db.collection('votings').countDocuments({ status: 'active' }),
      db.collection('votings').countDocuments({ status: 'completed' }),
      db.collection('votes').countDocuments()
    ]);
    
    res.json({
      code: 'SUCCESS',
      msg: 'Stats retrieved',
      data: {
        totalUsers,
        verifiedVoters,
        pendingKYC,
        activeVotings,
        completedVotings,
        totalVotesCast,
        nftsMinted: verifiedVoters
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ code: 'ERROR', msg: 'Server error', data: null });
  }
});

// ============================================
// Start Server
// ============================================
connectDB().then(async () => {
  // Initialize face verification models
  try {
    await initializeFaceVerification();
    console.log('Face verification initialized');
  } catch (error) {
    console.warn('Face verification initialization failed:', error.message);
  }
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
