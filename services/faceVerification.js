import * as faceapi from 'face-api.js';
import canvas from 'canvas';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const { Canvas, Image, ImageData } = canvas;

// Patch face-api.js for Node.js environment
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelsPath = path.join(__dirname, '..', 'models');

let modelsLoaded = false;

/**
 * Load face-api.js models
 */
async function loadModels() {
  if (modelsLoaded) return;
  
  try {
    console.log('Loading face detection models from:', modelsPath);
    
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);
    
    modelsLoaded = true;
    console.log('Face detection models loaded successfully');
  } catch (error) {
    console.error('Failed to load face detection models:', error);
    throw error;
  }
}

/**
 * Convert base64 image to canvas image
 * @param {string} base64Image - Base64 encoded image
 * @returns {Promise<Image>} Canvas image
 */
async function base64ToImage(base64Image) {
  // Remove data URL prefix if present
  let base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
  base64Data = base64Data.replace(/\s/g, '');
  
  // Convert to buffer
  let imageBuffer = Buffer.from(base64Data, 'base64');
  
  // Detect MIME type and convert to PNG/JPEG if needed
  const mimeMatch = base64Image.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  
  // Convert unsupported formats to JPEG
  if (mimeType === 'image/webp' || !['image/jpeg', 'image/png'].includes(mimeType)) {
    imageBuffer = await sharp(imageBuffer).jpeg({ quality: 90 }).toBuffer();
  }
  
  // Create canvas image
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = imageBuffer;
  });
}

/**
 * Detect face and get face descriptor
 * @param {Image} image - Canvas image
 * @returns {Promise<Object>} Face detection result
 */
async function detectFace(image) {
  const detection = await faceapi
    .detectSingleFace(image)
    .withFaceLandmarks()
    .withFaceDescriptor();
  
  return detection;
}

/**
 * Calculate Euclidean distance between two face descriptors
 * @param {Float32Array} descriptor1 - First face descriptor
 * @param {Float32Array} descriptor2 - Second face descriptor
 * @returns {number} Distance (lower = more similar)
 */
function calculateDistance(descriptor1, descriptor2) {
  return faceapi.euclideanDistance(descriptor1, descriptor2);
}

/**
 * Compare two faces and return similarity score
 * @param {string} idCardImage - Base64 encoded ID card image
 * @param {string} selfieImage - Base64 encoded selfie image
 * @returns {Promise<Object>} Comparison result
 */
export async function compareFaces(idCardImage, selfieImage) {
  try {
    // Ensure models are loaded
    await loadModels();
    
    console.log('Starting face comparison...');
    
    // Convert images
    console.log('Processing ID card image...');
    const idCardImg = await base64ToImage(idCardImage);
    
    console.log('Processing selfie image...');
    const selfieImg = await base64ToImage(selfieImage);
    
    // Detect faces
    console.log('Detecting face in ID card...');
    const idCardFace = await detectFace(idCardImg);
    
    if (!idCardFace) {
      return {
        success: false,
        error: 'No face detected in ID card image',
        step: 'id_card_detection'
      };
    }
    console.log('ID card face detected');
    
    console.log('Detecting face in selfie...');
    const selfieFace = await detectFace(selfieImg);
    
    if (!selfieFace) {
      return {
        success: false,
        error: 'No face detected in selfie image',
        step: 'selfie_detection'
      };
    }
    console.log('Selfie face detected');
    
    // Calculate distance between face descriptors
    const distance = calculateDistance(idCardFace.descriptor, selfieFace.descriptor);
    console.log('Face distance:', distance);
    
    // Convert distance to similarity percentage
    // Distance typically ranges from 0 (identical) to ~1.0+ (very different)
    // Threshold of 0.6 is commonly used for matching
    const threshold = 0.6;
    const isMatch = distance < threshold;
    
    // Convert to confidence percentage (inverse of distance)
    // 0 distance = 100% confidence, 0.6 distance = ~40% confidence
    const confidence = Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
    
    console.log('Face comparison result:', { isMatch, distance, confidence });
    
    return {
      success: true,
      isMatch,
      distance,
      confidence,
      confidencePercent: confidence,
      message: isMatch 
        ? `Face match confirmed with ${confidence}% confidence`
        : `Faces may not match (${confidence}% similarity, threshold: ${Math.round((1-threshold)*100)}%)`
    };
    
  } catch (error) {
    console.error('Face comparison error:', error);
    return {
      success: false,
      error: error.message,
      step: 'comparison'
    };
  }
}

/**
 * Check if face verification is available
 * @returns {boolean}
 */
export function isFaceVerificationAvailable() {
  return true; // Always available since it's local
}

/**
 * Pre-load models at startup
 */
export async function initializeFaceVerification() {
  try {
    await loadModels();
    return true;
  } catch (error) {
    console.error('Failed to initialize face verification:', error);
    return false;
  }
}
