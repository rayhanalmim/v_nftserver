import sharp from 'sharp';
import dotenv from 'dotenv';

dotenv.config();

const endpoint = process.env.AZURE_FACE_ENDPOINT;
const apiKey = process.env.AZURE_FACE_KEY;

if (!endpoint || !apiKey) {
  console.warn('Azure Face API credentials not found. Face verification will be disabled.');
}

/**
 * Detect faces in an image and get faceId
 * @param {Buffer} imageBuffer - Image buffer
 * @returns {Promise<Object>} Face detection result with faceId
 */
async function detectFace(imageBuffer) {
  try {
    const response = await fetch(`${endpoint}/face/v1.0/detect?returnFaceId=true&recognitionModel=recognition_04&detectionModel=detection_03`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Ocp-Apim-Subscription-Key': apiKey
      },
      body: imageBuffer
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Face detection error:', error);
      return { success: false, error: error.error?.message || 'Face detection failed' };
    }

    const faces = await response.json();
    
    if (faces.length === 0) {
      return { success: false, error: 'No face detected in the image' };
    }

    return { 
      success: true, 
      faceId: faces[0].faceId,
      faceCount: faces.length 
    };
  } catch (error) {
    console.error('Face detection error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Verify if two faces belong to the same person
 * @param {string} faceId1 - First face ID
 * @param {string} faceId2 - Second face ID
 * @returns {Promise<Object>} Verification result with confidence score
 */
async function verifyFaces(faceId1, faceId2) {
  try {
    const response = await fetch(`${endpoint}/face/v1.0/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': apiKey
      },
      body: JSON.stringify({ faceId1, faceId2 })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Face verification error:', error);
      return { success: false, error: error.error?.message || 'Face verification failed' };
    }

    const result = await response.json();
    return {
      success: true,
      isIdentical: result.isIdentical,
      confidence: result.confidence
    };
  } catch (error) {
    console.error('Face verification error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Convert image to JPEG buffer for Azure Face API
 * @param {string} base64Image - Base64 encoded image
 * @returns {Promise<Buffer>} JPEG image buffer
 */
async function prepareImageBuffer(base64Image) {
  // Remove data URL prefix if present
  let base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
  base64Data = base64Data.replace(/\s/g, '');
  
  let imageBuffer = Buffer.from(base64Data, 'base64');
  
  // Detect MIME type
  const mimeMatch = base64Image.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  
  // Convert to JPEG if not already (Azure Face API works best with JPEG)
  const supportedFormats = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'];
  if (!supportedFormats.includes(mimeType) || mimeType !== 'image/jpeg') {
    imageBuffer = await sharp(imageBuffer)
      .jpeg({ quality: 90 })
      .toBuffer();
  }
  
  return imageBuffer;
}

/**
 * Compare face from ID card with user's selfie
 * @param {string} idCardImage - Base64 encoded ID card image
 * @param {string} selfieImage - Base64 encoded selfie image
 * @returns {Promise<Object>} Comparison result
 */
export async function compareFaces(idCardImage, selfieImage) {
  if (!endpoint || !apiKey) {
    return {
      success: false,
      error: 'Azure Face API not configured. Please add AZURE_FACE_ENDPOINT and AZURE_FACE_KEY to environment variables.',
      skipped: true
    };
  }

  try {
    console.log('Starting face verification...');
    
    // Prepare images
    const [idCardBuffer, selfieBuffer] = await Promise.all([
      prepareImageBuffer(idCardImage),
      prepareImageBuffer(selfieImage)
    ]);
    
    console.log('ID card image size:', idCardBuffer.length, 'bytes');
    console.log('Selfie image size:', selfieBuffer.length, 'bytes');
    
    // Detect faces in both images
    console.log('Detecting face in ID card...');
    const idCardFace = await detectFace(idCardBuffer);
    if (!idCardFace.success) {
      return {
        success: false,
        error: `ID card face detection failed: ${idCardFace.error}`,
        step: 'id_card_detection'
      };
    }
    console.log('ID card face detected, faceId:', idCardFace.faceId);
    
    console.log('Detecting face in selfie...');
    const selfieFace = await detectFace(selfieBuffer);
    if (!selfieFace.success) {
      return {
        success: false,
        error: `Selfie face detection failed: ${selfieFace.error}`,
        step: 'selfie_detection'
      };
    }
    console.log('Selfie face detected, faceId:', selfieFace.faceId);
    
    // Verify if faces match
    console.log('Verifying faces...');
    const verification = await verifyFaces(idCardFace.faceId, selfieFace.faceId);
    if (!verification.success) {
      return {
        success: false,
        error: `Face verification failed: ${verification.error}`,
        step: 'verification'
      };
    }
    
    console.log('Face verification result:', {
      isIdentical: verification.isIdentical,
      confidence: verification.confidence
    });
    
    return {
      success: true,
      isMatch: verification.isIdentical,
      confidence: verification.confidence,
      confidencePercent: Math.round(verification.confidence * 100),
      message: verification.isIdentical 
        ? `Face match confirmed with ${Math.round(verification.confidence * 100)}% confidence`
        : `Faces do not match (${Math.round(verification.confidence * 100)}% similarity)`
    };
    
  } catch (error) {
    console.error('Face comparison error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Check if Face API is configured
 * @returns {boolean}
 */
export function isFaceAPIConfigured() {
  return !!(endpoint && apiKey);
}
