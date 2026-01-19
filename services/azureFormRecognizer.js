import { DocumentAnalysisClient, AzureKeyCredential } from '@azure/ai-form-recognizer';
import sharp from 'sharp';
import dotenv from 'dotenv';

dotenv.config();

const endpoint = process.env.AZURE_FORM_RECOGNIZER_ENDPOINT;
const apiKey = process.env.AZURE_FORM_RECOGNIZER_KEY;

if (!endpoint || !apiKey) {
  console.error('Azure Form Recognizer credentials not found in environment variables');
}

const client = new DocumentAnalysisClient(endpoint, new AzureKeyCredential(apiKey));

/**
 * Extract ID card information using Azure Form Recognizer
 * @param {string} base64Image - Base64 encoded image string
 * @returns {Promise<Object>} Extracted ID card data
 */
export async function extractIDCardData(base64Image) {
  try {
    // Remove data URL prefix if present and clean the base64 string
    let base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
    
    // Remove any whitespace or newlines
    base64Data = base64Data.replace(/\s/g, '');
    
    // Detect MIME type from original data URL
    let originalMimeType = 'image/jpeg'; // default
    const mimeMatch = base64Image.match(/^data:(image\/\w+);base64,/);
    if (mimeMatch) {
      originalMimeType = mimeMatch[1];
    }
    
    // Convert base64 to buffer
    let imageBuffer = Buffer.from(base64Data, 'base64');
    
    console.log('Original image buffer size:', imageBuffer.length, 'bytes');
    console.log('Original MIME type:', originalMimeType);
    
    // Azure Form Recognizer only supports: JPEG, PNG, BMP, TIFF, PDF
    // Convert unsupported formats (like WebP) to JPEG
    const supportedFormats = ['image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'application/pdf'];
    
    if (!supportedFormats.includes(originalMimeType)) {
      console.log('Converting image from', originalMimeType, 'to JPEG for Azure compatibility...');
      imageBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 90 })
        .toBuffer();
      console.log('Converted image buffer size:', imageBuffer.length, 'bytes');
    }
    
    // Use prebuilt-idDocument model for ID card analysis
    const poller = await client.beginAnalyzeDocument('prebuilt-idDocument', imageBuffer);
    const result = await poller.pollUntilDone();
    
    console.log('Azure Form Recognizer analysis complete');
    
    // Extract fields from the result
    const extractedData = parseAzureIDDocument(result);
    
    return {
      success: true,
      data: extractedData
    };
    
  } catch (error) {
    console.error('Azure Form Recognizer error:', error);
    return {
      success: false,
      error: error.message,
      data: null
    };
  }
}

/**
 * Parse Azure Form Recognizer result for Bangladesh NID
 * @param {Object} result - Azure Form Recognizer result
 * @returns {Object} Parsed ID card data
 */
function parseAzureIDDocument(result) {
  const extractedData = {
    name: 'Not detected',
    nameBangla: 'Not detected',
    fatherName: 'Not detected',
    motherName: 'Not detected',
    dateOfBirth: 'Not detected',
    idNumber: 'Not detected',
    address: 'Not detected',
    confidence: 0,
    extractionStatus: 'partial',
    errors: []
  };

  if (!result.documents || result.documents.length === 0) {
    extractedData.errors.push('No document detected in image');
    extractedData.extractionStatus = 'failed';
    return extractedData;
  }

  const document = result.documents[0];
  const fields = document.fields;
  
  console.log('Detected document type:', document.docType);
  console.log('Available fields:', Object.keys(fields || {}));

  // Extract common ID document fields
  if (fields) {
    // Name extraction - prefer structured fields first
    if (fields.FirstName?.content || fields.LastName?.content) {
      const firstName = fields.FirstName?.content || '';
      const lastName = fields.LastName?.content || '';
      extractedData.name = `${firstName} ${lastName}`.trim();
    } else if (fields.Name?.content) {
      extractedData.name = fields.Name.content;
    } else if (fields.FullName?.content) {
      extractedData.name = fields.FullName.content;
    }
    
    // Clean up name - remove Bengali text if present
    if (extractedData.name && extractedData.name !== 'Not detected') {
      // Extract only English name part (after "Name:" label if present)
      const nameMatch = extractedData.name.match(/Name:\s*([A-Z][A-Z\s.]+)/i);
      if (nameMatch) {
        extractedData.name = nameMatch[1].trim();
      } else {
        // If no "Name:" label, extract only English characters
        const englishOnly = extractedData.name.match(/([A-Z][A-Z\s.]+[A-Z])/);
        if (englishOnly) {
          extractedData.name = englishOnly[1].trim();
        }
      }
      // Remove any newlines and extra spaces
      extractedData.name = extractedData.name.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // ID Number extraction
    if (fields.DocumentNumber?.content) {
      extractedData.idNumber = fields.DocumentNumber.content.replace(/[\s-]/g, '');
    } else if (fields.IdNumber?.content) {
      extractedData.idNumber = fields.IdNumber.content.replace(/[\s-]/g, '');
    }

    // Date of Birth extraction
    if (fields.DateOfBirth?.content) {
      extractedData.dateOfBirth = formatDateOfBirth(fields.DateOfBirth.content);
    } else if (fields.BirthDate?.content) {
      extractedData.dateOfBirth = formatDateOfBirth(fields.BirthDate.content);
    }

    // Address extraction
    if (fields.Address?.content) {
      extractedData.address = fields.Address.content;
    } else if (fields.ResidentialAddress?.content) {
      extractedData.address = fields.ResidentialAddress.content;
    }

    // Calculate average confidence
    const confidenceValues = Object.values(fields)
      .filter(field => field.confidence !== undefined)
      .map(field => field.confidence);
    
    if (confidenceValues.length > 0) {
      extractedData.confidence = confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length;
    }
  }

  // Also check raw text content for Bangladesh-specific fields
  if (result.content) {
    const rawText = result.content;
    console.log('Raw extracted text:', rawText);

    // Split text into lines for analysis
    const lines = rawText.split(/[\n\r]+/).map(line => line.trim()).filter(line => line.length > 0);
    console.log('Parsed lines:', lines);

    // Find the Name line and Date of Birth line indices
    let nameLineIndex = -1;
    let dobLineIndex = -1;
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes('name:') && /[A-Z]{2,}/.test(lines[i])) {
        nameLineIndex = i;
      }
      if (lines[i].toLowerCase().includes('date of birth') || lines[i].toLowerCase().includes('birth:')) {
        dobLineIndex = i;
      }
    }

    console.log('Name line index:', nameLineIndex, 'DOB line index:', dobLineIndex);

    // Bangladesh NID structure: Name -> Bengali Name -> Father -> Mother -> DOB
    // Try to extract parent names from lines between Name and DOB
    if (nameLineIndex >= 0 && dobLineIndex > nameLineIndex) {
      const linesBetween = lines.slice(nameLineIndex + 1, dobLineIndex);
      console.log('Lines between Name and DOB:', linesBetween);
      
      // Look for lines that might contain parent names
      // Pattern: Bengali label followed by Bengali/English name
      // Father is typically 2 lines after Name, Mother is 1 line after Father
      
      for (let i = 0; i < linesBetween.length; i++) {
        const line = linesBetween[i];
        
        // Check if line contains Bengali father label (পিতা) or similar patterns
        // Also check for misrecognized text patterns that indicate father/mother lines
        if (extractedData.fatherName === 'Not detected') {
          // Look for patterns like "पिता:" or "শিশ:" (misrecognized পিতা)
          if (/^[^\x00-\x7F].*[:：]/.test(line) && i < linesBetween.length - 1) {
            // This might be the father label line, next line could have more info
            // Or check if there's an English name pattern on a nearby line
            const nextLine = linesBetween[i + 1] || '';
            const combinedText = line + ' ' + nextLine;
            
            // Extract any English-looking names (uppercase words)
            const englishNames = combinedText.match(/[A-Z][A-Z\s.]+[A-Z]/g);
            if (englishNames && englishNames.length > 0) {
              extractedData.fatherName = englishNames[0].replace(/\s+/g, ' ').trim();
            }
          }
        }
      }
    }

    // Alternative: Try to extract names using common patterns in Bangladesh NID
    // Father's name often appears after পিতা, पिता, or similar
    // Look for uppercase English text that looks like a name
    const allEnglishNames = rawText.match(/(?:MD\.|MO\.|MST\.|MRS\.|MR\.)?[A-Z][A-Z\s.]{3,}[A-Z]/g) || [];
    console.log('All English names found:', allEnglishNames);
    
    // Get the clean user name for comparison
    const cleanUserName = extractedData.name.replace(/\s+/g, ' ').trim().toUpperCase();
    
    // Filter out already extracted name and common non-name texts
    const potentialParentNames = allEnglishNames.filter(name => {
      const cleanName = name.trim().toUpperCase();
      // Strict comparison - exclude the exact user name
      return cleanName !== cleanUserName &&
             !cleanName.includes(cleanUserName) &&
             !cleanUserName.includes(cleanName) &&
             !cleanName.includes('GOVERNMENT') &&
             !cleanName.includes('BANGLADESH') &&
             !cleanName.includes('NATIONAL') &&
             !cleanName.includes('TEMPORARY') &&
             !cleanName.includes('CARD') &&
             !cleanName.includes('REPUBLIC') &&
             !cleanName.includes('ID NO') &&
             cleanName.length > 5;
    });
    
    console.log('Potential parent names:', potentialParentNames);
    
    // Assign father and mother names if found
    if (potentialParentNames.length >= 1 && extractedData.fatherName === 'Not detected') {
      extractedData.fatherName = potentialParentNames[0].replace(/\s+/g, ' ').trim();
    }
    if (potentialParentNames.length >= 2 && extractedData.motherName === 'Not detected') {
      extractedData.motherName = potentialParentNames[1].replace(/\s+/g, ' ').trim();
    }

    // Try direct Bengali pattern matching as fallback
    const fatherMatch = rawText.match(/(?:পিতা|पिता|Father)[:\s।]*([^\n\r]+)/i);
    if (fatherMatch && fatherMatch[1] && extractedData.fatherName === 'Not detected') {
      const englishMatch = fatherMatch[1].match(/([A-Z][A-Za-z\s.]+)/);
      if (englishMatch) {
        extractedData.fatherName = englishMatch[1].replace(/\s+/g, ' ').trim();
      }
    }

    const motherMatch = rawText.match(/(?:মাতা|माता|Mother)[:\s।]*([^\n\r]+)/i);
    if (motherMatch && motherMatch[1] && extractedData.motherName === 'Not detected') {
      const englishMatch = motherMatch[1].match(/([A-Z][A-Za-z\s.]+)/);
      if (englishMatch) {
        extractedData.motherName = englishMatch[1].replace(/\s+/g, ' ').trim();
      }
    }

    // If ID number not found in structured fields, try pattern matching
    if (extractedData.idNumber === 'Not detected') {
      const nidPatterns = [
        /ID\s*NO[:\s]*(\d{10,17})/i,
        /NID[:\s]*(\d{10,17})/i,
        /(\d{10}|\d{13}|\d{17})/g
      ];

      for (const pattern of nidPatterns) {
        const match = rawText.match(pattern);
        if (match && match[1]) {
          const cleanNid = match[1].replace(/\D/g, '');
          if (cleanNid.length === 10 || cleanNid.length === 13 || cleanNid.length === 17) {
            extractedData.idNumber = cleanNid;
            break;
          }
        }
      }
    }

    // If name not found, try pattern matching
    if (extractedData.name === 'Not detected') {
      const nameMatch = rawText.match(/Name[:\s]*([A-Z][A-Z\s.]+)/i);
      if (nameMatch && nameMatch[1]) {
        let potentialName = nameMatch[1].trim().replace(/[^A-Za-z\s.]/g, ' ').trim();
        potentialName = potentialName.replace(/\s+/g, ' ');
        if (potentialName.length > 3) {
          extractedData.name = potentialName;
        }
      }
    }

    // If DOB not found, try pattern matching
    if (extractedData.dateOfBirth === 'Not detected') {
      const dobMatch = rawText.match(/(?:Date\s*of\s*Birth|Birth)[:\s]*(\d{1,2}\s*[A-Za-z]+\s*\d{4})/i);
      if (dobMatch && dobMatch[1]) {
        extractedData.dateOfBirth = dobMatch[1].trim();
      }
    }
  }

  // Validate NID number format
  const nidNumber = extractedData.idNumber.replace(/[\s-]/g, '');
  const isValidNID = /^\d{10}$|^\d{13}$|^\d{17}$/.test(nidNumber);

  // Determine extraction status
  if (extractedData.name !== 'Not detected' && isValidNID) {
    extractedData.extractionStatus = 'success';
  } else if (extractedData.name === 'Not detected' && !isValidNID) {
    extractedData.extractionStatus = 'failed';
    extractedData.errors.push('Could not extract name and ID number');
  } else {
    extractedData.extractionStatus = 'partial';
    if (!isValidNID) {
      extractedData.errors.push('NID number format may be incorrect');
    }
    if (extractedData.name === 'Not detected') {
      extractedData.errors.push('Could not extract name');
    }
  }

  return extractedData;
}

/**
 * Format date of birth to standard format
 * @param {string} dateString - Date string from Azure
 * @returns {string} Formatted date string
 */
function formatDateOfBirth(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return dateString;
    }
    
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(date.getDate()).padStart(2, '0');
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    
    return `${day} ${month} ${year}`;
  } catch (error) {
    return dateString;
  }
}

/**
 * Extract text from any document using Azure Form Recognizer
 * @param {string} base64Image - Base64 encoded image string
 * @returns {Promise<Object>} Extracted text content
 */
export async function extractTextFromDocument(base64Image) {
  try {
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Use prebuilt-read model for general text extraction
    const poller = await client.beginAnalyzeDocument('prebuilt-read', imageBuffer);
    const result = await poller.pollUntilDone();
    
    return {
      success: true,
      text: result.content,
      pages: result.pages
    };
    
  } catch (error) {
    console.error('Azure text extraction error:', error);
    return {
      success: false,
      error: error.message,
      text: null
    };
  }
}
