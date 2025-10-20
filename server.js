                                                                                                const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuration: Enable strict username matching validation
// Set to false to allow any username to connect to any session
const STRICT_USERNAME_VALIDATION = false; // Can be changed to true for strict mode

// Client-specific conversation storage
// Map: clientId -> { clients: [SSE responses], conversation: [messages], activeUsernames: Set }
const clientSessions = new Map();

// Legacy SSE clients list (for backward compatibility with clients that don't send clientId)
const legacySseClients = [];

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(': connected\n\n');
  
  const clientId = req.query.clientId || req.headers['x-client-id'];
  
  if (clientId) {
    // Client-specific session
    if (!clientSessions.has(clientId)) {
      clientSessions.set(clientId, {
        clients: [],
        conversation: [], // Will be initialized with system prompt on first chat
        sources: new Set() // Track connection sources (web, windows)
      });
    }
    const session = clientSessions.get(clientId);
    
    // Track connection source from query param or header
    const source = req.query.source || req.headers['x-source'] || 'unknown';
    session.sources.add(source);
    
    session.clients.push(res);
    console.log(`SSE client connected with ID: ${clientId}, source: ${source}. Session clients: ${session.clients.length}`);
    
    req.on('close', () => {
      const idx = session.clients.indexOf(res);
      if (idx !== -1) session.clients.splice(idx, 1);
      console.log(`SSE client disconnected. ID: ${clientId}. Session clients: ${session.clients.length}`);
      
      // Clean up empty sessions after 5 minutes
      if (session.clients.length === 0) {
        setTimeout(() => {
          if (clientSessions.has(clientId) && clientSessions.get(clientId).clients.length === 0) {
            clientSessions.delete(clientId);
            console.log(`Cleaned up empty session: ${clientId}`);
          }
        }, 5 * 60 * 1000);
      }
    });
  } else {
    // Legacy mode - no clientId
    legacySseClients.push(res);
    console.log(`SSE client connected (legacy). Total clients: ${legacySseClients.length}`);
    
    req.on('close', () => {
      const idx = legacySseClients.indexOf(res);
      if (idx !== -1) legacySseClients.splice(idx, 1);
      console.log(`SSE client disconnected (legacy). Total clients: ${legacySseClients.length}`);
    });
  }
});

function broadcastEvent(obj, clientId = null) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  
  if (clientId && clientSessions.has(clientId)) {
    // Broadcast to specific client session
    const session = clientSessions.get(clientId);
    console.log(`Broadcasting to client ${clientId} (${session.clients.length} connections):`, JSON.stringify(obj).substring(0, 100));
    for (const client of session.clients) {
      try {
        client.write(payload);
      } catch (e) {
        console.error(`Failed to write to SSE client ${clientId}:`, e.message);
      }
    }
  } else {
    // Broadcast to all legacy clients (backward compatibility)
    console.log(`Broadcasting to ${legacySseClients.length} legacy clients:`, JSON.stringify(obj).substring(0, 100));
    for (const client of legacySseClients) {
      try {
        client.write(payload);
      } catch (e) {
        console.error('Failed to write to legacy SSE client:', e.message);
      }
    }
  }
}

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MAX_TOKENS = process.env.MAX_TOKENS ? parseInt(process.env.MAX_TOKENS, 10) : 32768;
const TEMPERATURE = process.env.TEMPERATURE ? parseFloat(process.env.TEMPERATURE) : 0.3;
const OPENROUTER_SYSTEM_PROMPT = process.env.OPENROUTER_SYSTEM_PROMPT || `You are an expert technical interview assistant. STRICTLY follow the exact cheat-sheet format below and nothing else. Do not add extra commentary, examples, or apologies. If you cannot answer precisely, respond with "I don't know." Keep responses extremely concise (preferably under 120 words).

Format to use (exact):

[Topic Name]
Definition:
- one short 1–2 line plain-language explanation.

Steps (if applicable):
- short bullet points, only if the concept is a process.

Time Complexity (if applicable):
Best Case: [value]
Worst Case: [value]

Space Complexity (if applicable):
[value]

Example output for "Binary Search":

[Binary Search]
Definition:
- Find an item's position in a sorted list by repeatedly halving the search interval until found or exhausted.

Steps (if applicable):
- Compare target to middle element.
- If equal return index, else search lower or upper half.

Time Complexity (if applicable):
Best Case: O(1)
Worst Case: O(log n)

Space Complexity (if applicable):
O(1)`;

if (!OPENROUTER_API_KEY) {
  console.warn('Warning: OPENROUTER_API_KEY is not set. Please set it in .env');
}

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  // Extract clientId from headers or query
  const clientId = req.query.clientId || req.headers['x-client-id'];

  // Check if this request is from the web UI or external source (Python script)
  const isWebUI = req.headers['x-source'] === 'web-ui';

  try {
    // Do NOT inject any server-side system prompt. Use the client's messages as the conversation start.
    const clientMessages = Array.isArray(messages) ? messages.slice() : [];
    const userMessages = clientMessages.filter(m => m.role === 'user');

    // If the user's last message appears to be asking for a program, detect it from the client's last user message
    const lastUserText = userMessages.length ? (userMessages[userMessages.length - 1].content || '') : '';

    // Intent detection (simple heuristics). We support three intents:
    // - code: user explicitly requests a program or 'write a' etc.
    // - steps: user asks for steps or 'program steps'
    // - cheatsheet: default - short definition/cheatsheet
  const lower = lastUserText.toLowerCase();
  const codeRequestKeywords = ['code', 'implement', 'write a', 'source code', 'script', 'function', 'class'];
  const stepsKeywords = ['steps', 'step', 'program steps', 'algorithm steps', 'pseudo', 'pseudocode', 'how to implement'];
  // If the user explicitly asks for "program steps" prefer steps intent over code
  const asksProgramSteps = lower.includes('program steps') || (lower.includes('program') && lower.includes('steps'));
  const wantsSteps = asksProgramSteps || stepsKeywords.some(k => lower.includes(k));
  const wantsCode = !wantsSteps && codeRequestKeywords.some(k => lower.includes(k));

  // For code requests we'll use an explicit user-level instruction when needed (avoid injecting server-side system prompts)
  const codeSystemPrompt = `You are a code assistant. When the user requests code, output ONLY the complete source code in a single triple-backtick code block with an explicit language tag (e.g., \`\`\`python). Do not include any additional explanation, headers, or steps. Ensure the code is runnable and minimal.`;
  const stepsSystemPrompt = `You are a concise technical assistant. When the user asks for steps, return only short numbered or bullet steps (no extra paragraphs), then optionally a one-line complexity summary.`;

    // Use the client's messages as the outgoing conversation start (do not inject server-side system prompts)
    const outgoingBase = clientMessages;
    
    // Get last user message (needed for greeting check and broadcasting)
    const lastUser = userMessages.length ? userMessages[userMessages.length - 1] : null;

    // Check for simple greetings and respond immediately
    const greetingKeywords = ['hi', 'hello', 'hey', 'greetings', 'good morning', 'good afternoon', 'good evening'];
    const isSimpleGreeting = lastUserText.trim().length < 20 && greetingKeywords.some(g => lastUserText.toLowerCase().includes(g));
    
    if (isSimpleGreeting) {
      const greetingResponse = `Hello! 👋 I'm your friendly technical interview assistant. I'm here to help you with:

- **Explaining concepts** in simple, easy-to-understand language
- **Providing code examples** with detailed comments
- **Breaking down algorithms** step-by-step
- **Answering technical questions** about programming, data structures, and more

Ask me anything! For example:
- "What is binary search?"
- "Explain how quicksort works"
- "Write a Python function to reverse a string"

What would you like to learn about today?`;

      // Broadcast greeting exchange
      if (lastUser) {
        broadcastEvent({ role: 'user', type: 'user', content: lastUser.content }, clientId);
      }
      broadcastEvent({ role: 'assistant', type: 'complete', content: greetingResponse, isStreaming: false }, clientId);

      return res.json({
        id: 'greeting-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: OPENROUTER_MODEL,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: greetingResponse },
          finish_reason: 'stop'
        }]
      });
    }

    // **STREAMING ENABLED**: Use responseType: 'stream' to get real-time chunks
    const resp = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: OPENROUTER_MODEL,
        messages: outgoingBase,
        max_tokens: 6000, // Increased for large code responses (within Mistral 7B's 8K limit)
        temperature: TEMPERATURE,
        stream: true,  // Enable streaming from OpenRouter
        top_p: 0.95,   // Add top_p for better completion
        presence_penalty: 0.0,  // Don't penalize topics
        frequency_penalty: 0.0  // Don't penalize repetition (helps avoid rollback)
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 300000,  // Increased to 5 minutes for large code responses
        responseType: 'stream',  // Receive response as a stream
        validateStatus: function (status) {
          return status >= 200 && status < 300; // Only accept 2xx status codes
        }
      }
    );

    // Check if response status is OK
    if (resp.status !== 200) {
      throw new Error(`OpenRouter API returned status ${resp.status}`);
    }

    // Broadcast user message first
    if (lastUser) {
      broadcastEvent({ role: 'user', type: 'user', content: lastUser.content }, clientId);
    }

    // Stream the response chunks in real-time
    let fullResponse = '';
    let buffer = '';
    let streamError = null;
    
    resp.data.on('data', (chunk) => {
      const chunkStr = chunk.toString('utf8');
      buffer += chunkStr;
      
      // Check if this is an error response (JSON error instead of SSE)
      if (buffer.includes('"error"') && buffer.includes('{') && !buffer.includes('data:')) {
        try {
          const errorData = JSON.parse(buffer);
          if (errorData.error) {
            streamError = errorData.error.message || errorData.error || 'API error occurred';
            return;
          }
        } catch (e) {
          // Not a JSON error, continue processing as SSE
        }
      }
      
      // Process complete SSE messages (data: {...}\n\n)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.substring(6).trim();
          
          // Skip [DONE] marker
          if (jsonStr === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed?.choices?.[0]?.delta?.content;
            
            if (delta) {
              // Filter out special tokens like <s>, </s>, <|endoftext|>, etc.
              // DON'T use .trim() here - it removes important line breaks and spacing
              const filteredDelta = delta.replace(/<\/?s>|<\|endoftext\|>|<\|im_start\|>|<\|im_end\|>/g, '');
              
              // Only add and broadcast if there's actual content after filtering
              // Check for content without trimming to preserve formatting
              if (filteredDelta && filteredDelta.length > 0) {
                fullResponse += filteredDelta;
                
                // Broadcast each chunk immediately to SSE clients (Windows app)
                broadcastEvent({ 
                  role: 'assistant', 
                  type: 'chunk',  // Mark as streaming chunk
                  content: filteredDelta,
                  isStreaming: true
                }, clientId);
              }
            }
          } catch (e) {
            console.warn('Failed to parse streaming chunk:', e.message);
          }
        }
      }
    });

    // Wait for stream to complete
    await new Promise((resolve, reject) => {
      resp.data.on('end', resolve);
      resp.data.on('error', reject);
    });

    // Check if stream error occurred
    if (streamError) {
      throw new Error(streamError);
    }

    // Clean up the full response - filter tokens again and trim only leading/trailing whitespace
    // Apply final token filter to catch any that slipped through
    let cleanedResponse = fullResponse.replace(/<\/?s>|<\|endoftext\|>|<\|im_start\|>|<\|im_end\|>/g, '').trim();
    
    // If response is empty after filtering tokens, provide helpful message
    if (!cleanedResponse || cleanedResponse.length === 0) {
      console.warn('Empty response received from OpenRouter after token filtering');
      const fallbackMessage = "I apologize, but I didn't generate a proper response. Please try asking your question again, or rephrase it slightly.";
      
      broadcastEvent({ 
        role: 'assistant', 
        type: 'complete',
        content: fallbackMessage,
        isStreaming: false
      }, clientId);
      
      return res.json({
        id: 'stream-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: OPENROUTER_MODEL,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: fallbackMessage
          },
          finish_reason: 'stop'
        }]
      });
    }

    // Broadcast final complete message
    broadcastEvent({ 
      role: 'assistant', 
      type: 'complete',  // Mark as final complete message
      content: cleanedResponse,
      isStreaming: false
    }, clientId);

    // Return standard chat completion format for compatibility
    const responseData = {
      id: 'stream-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: OPENROUTER_MODEL,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: cleanedResponse
        },
        finish_reason: 'stop'
      }]
    };

    return res.json(responseData);
  } catch (err) {
    console.error('OpenRouter error:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', err.response.data);
    }
    const status = err.response?.status || 500;
    const errorMessage = err.response?.data?.error?.message || err.response?.data?.error || err.message || 'Unknown error occurred';
    return res.status(status).json({ error: errorMessage });
  }
});

// ========================================
// INTERVIEW QUESTIONS GENERATOR ENDPOINT
// ========================================

// Configure file upload with multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOCX, and TXT files are allowed.'));
    }
  }
});

// Helper function to extract text from files
async function extractTextFromFile(file) {
  try {
    if (file.mimetype === 'application/pdf') {
      const data = await pdfParse(file.buffer);
      return data.text;
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return result.value;
    } else if (file.mimetype === 'text/plain') {
      return file.buffer.toString('utf-8');
    }
    return '';
  } catch (error) {
    console.error('Error extracting text from file:', error);
    throw new Error('Failed to extract text from file');
  }
}

// Generate interview questions using Mistral 7B
async function generateInterviewQuestions(resumeText, jobDescriptionText) {
  // Simpler, more direct prompt
  const systemPrompt = `You are an expert technical interviewer. Analyze the resume and job description, then generate specific interview questions.

Return a JSON object with this structure:
{
  "analysis": {
    "role": "job title",
    "experienceLevel": "Junior/Mid/Senior",
    "matchingSkills": ["skill1", "skill2"],
    "skillGaps": ["gap1", "gap2"]
  },
  "questions": {
    "basic": [{"question": "text", "reasoning": "why", "focusArea": "topic", "difficulty": 2}],
    "advanced": [{"question": "text", "reasoning": "why", "focusArea": "topic", "difficulty": 4}],
    "scenario": [{"question": "text", "reasoning": "why", "focusArea": "topic", "difficulty": 5}]
  }
}

IMPORTANT: Generate EXACTLY 20 questions for each category (basic, advanced, scenario). Total 60 questions.
- Basic: 20 fundamental questions (difficulty: 2)
- Advanced: 20 in-depth technical questions (difficulty: 4)  
- Scenario: 20 real-world problem-solving questions (difficulty: 5)

Questions must be specific to the candidate's resume and job requirements. Return ONLY valid JSON.`;

  const userPrompt = `RESUME:\n${resumeText.substring(0, 2000)}\n\nJOB DESCRIPTION:\n${jobDescriptionText.substring(0, 1500)}\n\nGenerate interview questions as JSON.`;

  try {
    console.log('Making API call to OpenRouter...');
    console.log('Model:', OPENROUTER_MODEL);
    console.log('Resume length:', resumeText.length, 'chars');
    console.log('Job desc length:', jobDescriptionText.length, 'chars');
    
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 8000,
        temperature: 0.7,
        top_p: 0.95
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'SkillSpeak Interview Generator'
        },
        timeout: 60000 // 60 second timeout
      }
    );

    console.log('API Response Status:', response.status);
    console.log('Response data structure:', {
      hasChoices: !!response.data?.choices,
      choicesLength: response.data?.choices?.length,
      hasMessage: !!response.data?.choices?.[0]?.message,
      hasContent: !!response.data?.choices?.[0]?.message?.content
    });

    // Log the full response for debugging
    console.log('=== FULL API RESPONSE ===');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('========================');

    if (!response.data?.choices?.[0]?.message?.content) {
      console.error('Empty response from API!');
      console.error('Full response:', JSON.stringify(response.data, null, 2));
      throw new Error('API returned empty response');
    }

    const content = response.data.choices[0].message.content;
    
    console.log('=== Mistral Response Preview ===');
    console.log('First 500 chars:', content.substring(0, 500));
    console.log('Last 200 chars:', content.substring(content.length - 200));
    console.log('================================');
    
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(content);
      return parsed;
    } catch (e) {
      console.log('Direct JSON parse failed, trying to extract from markdown...');
      
      // If not valid JSON, try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        console.log('Found JSON in markdown code block');
        return JSON.parse(jsonMatch[1]);
      }
      
      // Try without json tag
      const codeMatch = content.match(/```\s*([\s\S]*?)\s*```/);
      if (codeMatch) {
        console.log('Found content in code block (no json tag)');
        return JSON.parse(codeMatch[1]);
      }
      
      // Log the full content for debugging
      console.error('=== FULL RESPONSE (could not parse) ===');
      console.error(content);
      console.error('=======================================');
      
      // If still can't parse, return structured error
      throw new Error('Failed to parse response as JSON');
    }
  } catch (error) {
    console.error('Error calling OpenRouter API:', error.message);
    if (error.response) {
      console.error('API Error Response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    }
    throw error;
  }
}

// Interview Questions Generation Endpoint
app.post('/api/generate-interview-questions',
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'jobDescription', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      console.log('Received interview questions generation request');

      // Extract resume text
      if (!req.files || !req.files['resume']) {
        return res.status(400).json({ error: 'Resume file is required' });
      }

      const resumeFile = req.files['resume'][0];
      console.log('Resume file:', resumeFile.originalname, resumeFile.mimetype);
      
      const resumeText = await extractTextFromFile(resumeFile);
      
      if (!resumeText || resumeText.trim().length < 50) {
        return res.status(400).json({ error: 'Resume file appears to be empty or too short' });
      }

      // Extract job description text
      let jobDescriptionText = '';
      
      // Check if job description was uploaded as file
      if (req.files && req.files['jobDescription']) {
        const jdFile = req.files['jobDescription'][0];
        console.log('Job description file:', jdFile.originalname, jdFile.mimetype);
        jobDescriptionText = await extractTextFromFile(jdFile);
      } 
      // Otherwise get from request body (check both field names)
      else if (req.body.jobDescriptionText) {
        jobDescriptionText = req.body.jobDescriptionText;
        console.log('Job description from textarea:', jobDescriptionText.substring(0, 100));
      } else if (req.body.jobDescription) {
        jobDescriptionText = req.body.jobDescription;
        console.log('Job description from body:', jobDescriptionText.substring(0, 100));
      }

      if (!jobDescriptionText || jobDescriptionText.trim().length < 20) {
        return res.status(400).json({ error: 'Job description is required and must be at least 20 characters' });
      }

      console.log('Resume text length:', resumeText.length);
      console.log('Job description length:', jobDescriptionText.length);

      // Generate interview questions
      console.log('Calling Mistral 7B to generate questions...');
      const questions = await generateInterviewQuestions(resumeText, jobDescriptionText);

      console.log('Successfully generated questions');
      res.json(questions);

    } catch (error) {
      console.error('Error in interview questions generation:', error);
      
      if (error.message.includes('Invalid file type')) {
        return res.status(400).json({ error: error.message });
      }
      
      if (error.response) {
        return res.status(error.response.status).json({
          error: error.response.data?.error?.message || 'API error occurred'
        });
      }
      
      res.status(500).json({
        error: 'Failed to generate interview questions. Please try again.'
      });
    }
  }
);

// Generate answers for interview questions
app.post('/api/generate-answers', async (req, res) => {
  try {
    const { questions, resumeText, jobDescriptionText } = req.body;
    
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Questions array is required' });
    }

    console.log('Generating answers for', questions.length, 'questions');

    const answers = [];
    
    // Generate answers in batches to avoid timeout
    for (const q of questions) {
      try {
        const systemPrompt = `You are an expert interviewer providing model answers for technical interview questions. 
Generate a comprehensive, professional answer that demonstrates strong technical knowledge.

The answer should:
- Be 3-5 sentences long
- Show deep understanding of the concept
- Include specific examples or use cases
- Be suitable for the question's difficulty level
- Sound professional and confident

Return only the answer text, no JSON, no formatting.`;

        const userPrompt = `Question: ${q.question}\n\nContext: ${q.reasoning || ''}\n\nProvide a model answer:`;

        const response = await axios.post(
          `${OPENROUTER_BASE_URL}/chat/completions`,
          {
            model: OPENROUTER_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 500,
            temperature: 0.7
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        );

        const answer = response.data.choices[0].message.content.trim();
        
        answers.push({
          question: q.question,
          answer: answer,
          category: q.category || q.focusArea,
          reasoning: q.reasoning
        });

      } catch (error) {
        console.error('Error generating answer for question:', error.message);
        answers.push({
          question: q.question,
          answer: 'Answer generation failed. Please try again.',
          category: q.category || q.focusArea,
          reasoning: q.reasoning
        });
      }
    }

    res.json({ answers });

  } catch (error) {
    console.error('Error in answer generation:', error);
    res.status(500).json({ error: 'Failed to generate answers' });
  }
});

// ============================================
// INTERVIEWER RATING DASHBOARD ENDPOINTS
// ============================================

// In-memory storage for question ratings
// Structure: { sessionId: { questions: [...], ratings: { questionIndex: rating } } }
const ratingSessions = new Map();

// Endpoint: Save ratings for questions
app.post('/api/save-ratings', (req, res) => {
  try {
    const { sessionId, ratings } = req.body;
    
    if (!sessionId || !ratings) {
      return res.status(400).json({ error: 'Session ID and ratings are required' });
    }
    
    if (!ratingSessions.has(sessionId)) {
      ratingSessions.set(sessionId, { questions: [], ratings: {} });
    }
    
    const session = ratingSessions.get(sessionId);
    
    // Update ratings (merge with existing)
    Object.keys(ratings).forEach(questionIndex => {
      session.ratings[questionIndex] = ratings[questionIndex];
    });
    
    console.log(`Saved ratings for session ${sessionId}:`, session.ratings);
    
    res.json({ 
      success: true, 
      message: 'Ratings saved successfully',
      totalRated: Object.keys(session.ratings).length
    });
    
  } catch (error) {
    console.error('Error saving ratings:', error);
    res.status(500).json({ error: 'Failed to save ratings' });
  }
});

// Endpoint: Store generated questions for a session
app.post('/api/store-questions', (req, res) => {
  try {
    const { sessionId, questions } = req.body;
    
    if (!sessionId || !questions) {
      return res.status(400).json({ error: 'Session ID and questions are required' });
    }
    
    if (!ratingSessions.has(sessionId)) {
      ratingSessions.set(sessionId, { questions: [], ratings: {} });
    }
    
    const session = ratingSessions.get(sessionId);
    session.questions = questions;
    
    console.log(`Stored ${questions.length} questions for session ${sessionId}`);
    
    res.json({ 
      success: true, 
      message: 'Questions stored successfully',
      totalQuestions: questions.length
    });
    
  } catch (error) {
    console.error('Error storing questions:', error);
    res.status(500).json({ error: 'Failed to store questions' });
  }
});

// Endpoint: Get rating report
app.get('/api/rating-report/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!ratingSessions.has(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const session = ratingSessions.get(sessionId);
    const { questions, ratings } = session;
    
    // Calculate overall statistics
    const totalQuestions = questions.length;
    const ratedQuestions = Object.keys(ratings).length;
    const ratingValues = Object.values(ratings);
    
    let overallAverage = 0;
    if (ratedQuestions > 0) {
      const sum = ratingValues.reduce((acc, rating) => acc + rating, 0);
      overallAverage = (sum / ratedQuestions).toFixed(2);
    }
    
    // Calculate level-based statistics
    const levelStats = {};
    
    questions.forEach((q, index) => {
      const level = q.difficulty || q.level || 'Unknown';
      const rating = ratings[index];
      
      if (!levelStats[level]) {
        levelStats[level] = {
          total: 0,
          rated: 0,
          sumRatings: 0,
          average: 0
        };
      }
      
      levelStats[level].total++;
      
      if (rating !== undefined) {
        levelStats[level].rated++;
        levelStats[level].sumRatings += rating;
      }
    });
    
    // Calculate averages for each level
    Object.keys(levelStats).forEach(level => {
      const stats = levelStats[level];
      if (stats.rated > 0) {
        stats.average = (stats.sumRatings / stats.rated).toFixed(2);
      }
    });
    
    // Create detailed report
    const report = {
      sessionId,
      summary: {
        totalQuestions,
        totalRated: ratedQuestions,
        overallAverage: parseFloat(overallAverage),
        ratingPercentage: totalQuestions > 0 ? ((ratedQuestions / totalQuestions) * 100).toFixed(1) : 0
      },
      levelBreakdown: levelStats,
      questions: questions.map((q, index) => ({
        ...q,
        index,
        rating: ratings[index] || null,
        isRated: ratings[index] !== undefined
      }))
    };
    
    res.json(report);
    
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// Endpoint: Get all sessions (for dashboard listing)
app.get('/api/rating-sessions', (req, res) => {
  try {
    const sessions = [];
    
    ratingSessions.forEach((data, sessionId) => {
      const ratedCount = Object.keys(data.ratings).length;
      sessions.push({
        sessionId,
        totalQuestions: data.questions.length,
        totalRated: ratedCount,
        progress: data.questions.length > 0 
          ? ((ratedCount / data.questions.length) * 100).toFixed(1)
          : 0
      });
    });
    
    res.json({ sessions });
    
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ============================================
// RESUME-AWARE CHAT ASSISTANT (PRO FEATURE)
// ============================================

// In-memory storage for parsed resume data
const resumeDataStore = new Map();

// Parse resume to extract key parameters
async function parseResumeData(resumeText) {
  try {
    const systemPrompt = `You are an AI that extracts structured information from resumes.
Analyze the resume and extract key parameters in JSON format.

Return a JSON object with this structure:
{
  "experience": {
    "totalYears": number,
    "currentRole": "string",
    "previousRoles": ["role1", "role2"]
  },
  "technologies": {
    "languages": ["language1", "language2"],
    "frameworks": ["framework1", "framework2"],
    "tools": ["tool1", "tool2"],
    "cloud": ["cloud1", "cloud2"]
  },
  "education": {
    "degrees": ["degree1"],
    "certifications": ["cert1", "cert2"]
  },
  "projects": [
    {
      "name": "project name",
      "description": "brief description",
      "technologies": ["tech1", "tech2"]
    }
  ],
  "domain": ["domain1", "domain2"],
  "keyAchievements": ["achievement1", "achievement2"]
}

Extract all available information. Return ONLY valid JSON.`;

    const userPrompt = `RESUME:\n${resumeText.substring(0, 3000)}\n\nExtract resume data as JSON.`;

    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 2000,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'SkillSpeak Resume Parser'
        },
        timeout: 30000
      }
    );

    const content = response.data.choices[0].message.content;
    
    console.log('=== Resume Parser Response ===');
    console.log('First 500 chars:', content.substring(0, 500));
    console.log('Last 200 chars:', content.substring(content.length - 200));
    console.log('==============================');
    
    // Try to parse JSON
    try {
      return JSON.parse(content);
    } catch (e) {
      console.log('Direct JSON parse failed, trying markdown extraction...');
      
      // Try to extract from markdown
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        console.log('Found JSON in code block');
        try {
          return JSON.parse(jsonMatch[1]);
        } catch (parseError) {
          console.error('Failed to parse extracted JSON:', parseError);
          console.error('Extracted content:', jsonMatch[1].substring(0, 500));
        }
      }
      
      // If all parsing fails, return a default structure
      console.error('=== FULL RESUME PARSER RESPONSE (Failed to parse) ===');
      console.error(content);
      console.error('=====================================================');
      
      // Return minimal structure based on text analysis
      return {
        experience: {
          totalYears: "Unknown",
          currentRole: "Not specified",
          previousRoles: []
        },
        technologies: {
          languages: [],
          frameworks: [],
          tools: [],
          cloud: []
        },
        education: {
          degrees: [],
          certifications: []
        },
        projects: [],
        domain: [],
        keyAchievements: []
      };
    }
  } catch (error) {
    console.error('Error in parseResumeData:', error);
    throw error;
  }
}

// Endpoint: Parse and store resume data
app.post('/api/parse-resume', 
  upload.fields([{ name: 'resume', maxCount: 1 }]),
  async (req, res) => {
    try {
      if (!req.files || !req.files['resume']) {
        return res.status(400).json({ error: 'Resume file is required' });
      }

      const resumeFile = req.files['resume'][0];
      console.log('Parsing resume:', resumeFile.originalname);

      // Extract text from resume
      const resumeText = await extractTextFromFile(resumeFile);
      
      if (!resumeText || resumeText.trim().length < 50) {
        return res.status(400).json({ error: 'Resume file appears to be empty or too short' });
      }

      // Parse resume data using AI
      const resumeData = await parseResumeData(resumeText);
      
      // Generate unique session ID
      const sessionId = `resume_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Store resume data with full text
      resumeDataStore.set(sessionId, {
        data: resumeData,
        fullText: resumeText,
        timestamp: new Date()
      });

      console.log('Resume parsed successfully, session:', sessionId);
      
      res.json({
        success: true,
        sessionId,
        resumeData,
        summary: {
          experience: resumeData.experience?.totalYears || 'Not specified',
          role: resumeData.experience?.currentRole || 'Not specified',
          technologies: [
            ...(resumeData.technologies?.languages || []),
            ...(resumeData.technologies?.frameworks || [])
          ].slice(0, 5)
        }
      });

    } catch (error) {
      console.error('Error parsing resume:', error);
      res.status(500).json({ error: 'Failed to parse resume' });
    }
  }
);

// Endpoint: Parse resume text (pasted)
app.post('/api/parse-resume-text', async (req, res) => {
  try {
    const { resumeText } = req.body;

    if (!resumeText || typeof resumeText !== 'string') {
      return res.status(400).json({ error: 'Resume text is required' });
    }

    if (resumeText.trim().length < 100) {
      return res.status(400).json({ error: 'Resume text is too short. Please provide more details.' });
    }

    console.log('Parsing resume text, length:', resumeText.length);

    // Parse resume data using AI with the provided text
    const resumeData = await parseResumeData(resumeText);
    
    // Generate unique session ID
    const sessionId = `resume_text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Store resume data with full text
    resumeDataStore.set(sessionId, {
      data: resumeData,
      fullText: resumeText,
      timestamp: new Date(),
      source: 'text' // Mark as text input for reference
    });

    console.log('Resume text parsed successfully, session:', sessionId);
    
    res.json({
      success: true,
      sessionId,
      resumeData,
      summary: {
        experience: resumeData.experience?.totalYears || 'Not specified',
        role: resumeData.experience?.currentRole || 'Not specified',
        technologies: [
          ...(resumeData.technologies?.languages || []),
          ...(resumeData.technologies?.frameworks || [])
        ].slice(0, 5)
      }
    });

  } catch (error) {
    console.error('Error parsing resume text:', error);
    res.status(500).json({ error: 'Failed to parse resume text' });
  }
});

// Endpoint: Resume-aware chat (Pro feature)
app.post('/api/chat-with-resume', async (req, res) => {
  try {
    const { message, sessionId, mode } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!sessionId || !resumeDataStore.has(sessionId)) {
      return res.status(400).json({ error: 'Invalid or expired resume session' });
    }

    // Extract clientId for Windows app sync
    const clientId = req.query.clientId || req.headers['x-client-id'];

    const resumeSession = resumeDataStore.get(sessionId);
    const resumeData = resumeSession.data;
    const fullResumeText = resumeSession.fullText || '';

    // Broadcast user message to Windows app
    if (clientId) {
      broadcastEvent({ 
        role: 'user', 
        type: 'user', 
        content: message 
      }, clientId);
    }

    // Build context-aware system prompt with full resume context
    const systemPrompt = `You are a helpful interview coach assistant. You're helping a candidate prepare for interviews by answering questions based on their actual resume and experience.

CANDIDATE PROFILE:
- Experience: ${resumeData.experience?.totalYears || 'Not specified'} years
- Current Role: ${resumeData.experience?.currentRole || 'Not specified'}
- Key Technologies: ${[
  ...(resumeData.technologies?.languages || []),
  ...(resumeData.technologies?.frameworks || []),
  ...(resumeData.technologies?.tools || [])
].slice(0, 10).join(', ')}
- Domain Experience: ${(resumeData.domain || []).join(', ')}
- Education: ${(resumeData.education?.degrees || []).join(', ')}
- Certifications: ${(resumeData.education?.certifications || []).join(', ')}

KEY PROJECTS:
${(resumeData.projects || []).slice(0, 3).map(p => 
  `- ${p.name}: ${p.description} (${(p.technologies || []).join(', ')})`
).join('\n')}

FULL RESUME CONTEXT (for detailed reference):
${fullResumeText.substring(0, 2000)}${fullResumeText.length > 2000 ? '...' : ''}

INSTRUCTIONS:
When answering interview questions:
1. Base answers on the candidate's ACTUAL experience and skills from their resume
2. Reference specific projects, technologies, or achievements they have
3. Use details from the full resume text to provide accurate, personalized answers
4. Keep answers simple, clear, and conversational - like a real human would speak in an interview
5. Avoid jargon or overly technical language unless the question specifically asks for it
6. Make answers sound natural and confident, not scripted or robotic
7. Keep responses concise (3-5 sentences unless more detail is requested)
8. If the candidate doesn't have direct experience with something, suggest how they could relate their existing experience to it
9. When discussing projects or achievements, use specific details from the resume

Answer style: ${mode === 'detailed' ? 'Provide comprehensive, in-depth answers with examples from their resume' : 'Give brief, clear answers suitable for interview responses'}`;

    // Enable streaming response
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: mode === 'detailed' ? 1000 : 500,
        temperature: 0.7,
        top_p: 0.95,
        stream: true
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'SkillSpeak Resume-Aware Chat'
        },
        responseType: 'stream',
        timeout: 30000
      }
    );

    // Set headers for SSE streaming to browser
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullAnswer = '';

    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          
          if (data === '[DONE]') {
            // Send complete message to Windows app
            if (clientId) {
              broadcastEvent({ 
                role: 'assistant',
                type: 'complete',
                content: fullAnswer,
                isStreaming: false
              }, clientId);
            }
            
            // Send final event to browser
            res.write(`data: ${JSON.stringify({ 
              type: 'complete', 
              content: fullAnswer,
              basedOn: {
                experience: resumeData.experience?.totalYears,
                role: resumeData.experience?.currentRole,
                technologies: [
                  ...(resumeData.technologies?.languages || []),
                  ...(resumeData.technologies?.frameworks || [])
                ].slice(0, 5)
              }
            })}\n\n`);
            res.end();
            return;
          }
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            
            if (content) {
              fullAnswer += content;
              
              // Send chunk to browser
              res.write(`data: ${JSON.stringify({ 
                type: 'chunk', 
                content: content 
              })}\n\n`);
              
              // Broadcast chunk to Windows app
              if (clientId) {
                broadcastEvent({ 
                  role: 'assistant',
                  type: 'chunk',
                  content: content,
                  isStreaming: true
                }, clientId);
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    });

    response.data.on('end', () => {
      if (!res.writableEnded) {
        // Send complete message to Windows app if not already sent
        if (clientId) {
          broadcastEvent({ 
            role: 'assistant',
            type: 'complete',
            content: fullAnswer,
            isStreaming: false
          }, clientId);
        }
        
        res.write(`data: ${JSON.stringify({ 
          type: 'complete', 
          content: fullAnswer,
          basedOn: {
            experience: resumeData.experience?.totalYears,
            role: resumeData.experience?.currentRole,
            technologies: [
              ...(resumeData.technologies?.languages || []),
              ...(resumeData.technologies?.frameworks || [])
            ].slice(0, 5)
          }
        })}\n\n`);
        res.end();
      }
    });

    response.data.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream error' })}\n\n`);
        res.end();
      }
    });

  } catch (error) {
    console.error('Error in resume-aware chat:', error);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// Only start server if not running in Vercel
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
