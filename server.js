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
    "basic": [{"question": "text", "reasoning": "why", "focusArea": "topic", "difficulty": 2, "type": "technical or coding"}],
    "advanced": [{"question": "text", "reasoning": "why", "focusArea": "topic", "difficulty": 4, "type": "technical or coding"}],
    "scenario": [{"question": "text", "reasoning": "why", "focusArea": "topic", "difficulty": 5, "type": "technical or coding"}]
  }
}

IMPORTANT: Generate EXACTLY 10 questions for each category (basic, advanced, scenario). Total 30 questions.

QUESTION TYPE DISTRIBUTION - MUST FOLLOW:
- Basic (10 questions): 80% Technical Concepts + 20% Coding Problems
  * 8 Technical: Definitions, concepts, theory, best practices, system design basics
  * 2 Coding: Write simple functions, basic algorithms, easy programming tasks
  
- Advanced (10 questions): 80% Technical + 20% Coding Problems
  * 8 Technical: Architecture, optimization, complex concepts, trade-offs
  * 2 Coding: Implement algorithms, data structures, complex logic, optimize code
  
- Scenario (10 questions): 80% Technical + 20% Coding Problems
  * 8 Technical: System design, scalability, real-world architecture decisions
  * 2 Coding: Solve real-world problems with code, build features, debug scenarios

CODING QUESTIONS MUST:
- Ask candidate to "Write code", "Implement", "Code a solution", "Create a function"
- Be specific about input/output or requirements
- Match the technologies in resume and job description
- Include edge cases to consider

TECHNICAL QUESTIONS MUST:
- Ask about concepts, architecture, design patterns, best practices
- Focus on "Explain", "What is", "How does", "When to use", "Compare"
- Test understanding without requiring code

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
      
      // Handle specific error codes
      if (error.response.status === 402) {
        const creditError = new Error('API_CREDITS_EXHAUSTED');
        creditError.status = 402;
        creditError.userMessage = '⚠️ OpenRouter API credits exhausted. Please add credits to your account at https://openrouter.ai/credits';
        throw creditError;
      }
      
      if (error.response.status === 429) {
        const rateLimitError = new Error('RATE_LIMIT_EXCEEDED');
        rateLimitError.status = 429;
        rateLimitError.userMessage = '⚠️ Rate limit exceeded. Please wait a moment and try again.';
        throw rateLimitError;
      }
    }
    throw error;
  }
}

// Interview Questions Generation Endpoint (with SSE progress streaming)
app.post('/api/generate-interview-questions',
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'jobDescription', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      console.log('Received interview questions generation request');

      // Extract resume text - from file or text
      let resumeText = '';
      
      if (req.files && req.files['resume']) {
        const resumeFile = req.files['resume'][0];
        console.log('Resume file:', resumeFile.originalname, resumeFile.mimetype);
        resumeText = await extractTextFromFile(resumeFile);
      } else if (req.body.resumeText) {
        resumeText = req.body.resumeText;
        console.log('Resume from text input:', resumeText.substring(0, 100));
      } else {
        return res.status(400).json({ error: 'Resume file or text is required' });
      }
      
      if (!resumeText || resumeText.trim().length < 50) {
        return res.status(400).json({ error: 'Resume appears to be empty or too short (minimum 50 characters)' });
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

      // Set up SSE headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send progress: Analyzing resume
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        stage: 'Analyzing resume and job description'
      })}\n\n`);

      // Generate interview questions
      console.log('Calling Mistral 7B to generate questions...');
      
      // Send progress: Calling AI
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        stage: 'Generating questions with AI'
      })}\n\n`);

      const questions = await generateInterviewQuestions(resumeText, jobDescriptionText);

      // Send progress: Processing results
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        stage: 'Processing results'
      })}\n\n`);

      console.log('Successfully generated questions');
      
      // Send completion with data
      res.write(`data: ${JSON.stringify({
        type: 'complete',
        data: questions
      })}\n\n`);

      res.end();

    } catch (error) {
      console.error('Error in interview questions generation:', error);
      
      // Handle custom error messages
      let errorMessage = 'Failed to generate interview questions. Please try again.';
      if (error.userMessage) {
        errorMessage = error.userMessage;
      } else if (error.message === 'API_CREDITS_EXHAUSTED') {
        errorMessage = '⚠️ OpenRouter API credits exhausted. Please add credits at https://openrouter.ai/credits';
      } else if (error.message === 'RATE_LIMIT_EXCEEDED') {
        errorMessage = '⚠️ Rate limit exceeded. Please wait a moment and try again.';
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      // Send error event
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: errorMessage
      })}\n\n`);
      
      res.end();
    }
  }
);

// Generate answers for interview questions (with resume context and SSE streaming)
app.post('/api/generate-answers', async (req, res) => {
  try {
    const { questions, resumeText, jobDescriptionText } = req.body;
    
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Questions array is required' });
    }

    console.log('Generating answers for', questions.length, 'questions');
    console.log(`Resume provided: ${resumeText ? 'Yes' : 'No'} (${resumeText?.length || 0} chars)`);
    console.log(`Job Description provided: ${jobDescriptionText ? 'Yes' : 'No'} (${jobDescriptionText?.length || 0} chars)`);

    // Set up SSE headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const answers = [];
    
    // Generate answers with progress tracking
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      
      try {
        // Check if this is a coding question
        const isCodingQuestion = q.type && (q.type.toLowerCase().includes('coding') || q.type.toLowerCase() === 'coding');
        
        // Build appropriate system prompt based on question type
        let systemPrompt = '';
        let userPrompt = '';
        
        if (isCodingQuestion) {
          // For CODING questions - provide actual working code
          systemPrompt = `You are an expert programmer helping a candidate prepare coding solutions for technical interviews.

IMPORTANT: For coding questions, you MUST provide COMPLETE, WORKING CODE.

Your response should follow this format:

**Code Solution:**

\`\`\`[language]
// Complete working code here
// Include all necessary imports/dependencies
// Add helpful comments
// Make it production-ready
\`\`\`

**Explanation:**
Brief 2-3 sentence explanation of how the code works and key concepts used. Use plain text - NO strikethrough formatting (~~text~~) allowed.

**Time & Space Complexity:**
- Time: O(...)
- Space: O(...)

FORMATTING RULES:
- Use code blocks ONLY for actual code
- Explanation and complexity sections: plain text ONLY
- ABSOLUTELY NO tildes (~) or strikethrough formatting
- Keep explanations clean and simple

Use the programming language most relevant to the candidate's resume or job requirements.
Make the code clean, efficient, and interview-ready.`;

          userPrompt = `Question: ${q.question}\n\n`;
          
          if (resumeText && resumeText.trim()) {
            // Extract primary programming languages from resume
            const languages = ['Python', 'JavaScript', 'Java', 'C++', 'C#', 'Go', 'Ruby', 'TypeScript'];
            const resumeLower = resumeText.toLowerCase();
            const foundLanguages = languages.filter(lang => resumeLower.includes(lang.toLowerCase()));
            
            if (foundLanguages.length > 0) {
              userPrompt += `Candidate knows: ${foundLanguages.join(', ')}\n`;
              userPrompt += `Prefer using: ${foundLanguages[0]}\n\n`;
            }
          }
          
          if (jobDescriptionText && jobDescriptionText.trim()) {
            userPrompt += `Job Requirements: ${jobDescriptionText.substring(0, 300)}\n\n`;
          }
          
          userPrompt += `Provide a COMPLETE, WORKING code solution with explanation and complexity analysis.`;
          
        } else {
          // For TECHNICAL questions - provide conceptual answers
          systemPrompt = `You are helping a candidate prepare personalized, authentic answers for technical interview questions.`;
          
          if (resumeText && resumeText.trim()) {
            systemPrompt += `\n\n=== CANDIDATE'S RESUME ===\n${resumeText}\n========================\n\n`;
            systemPrompt += `CRITICAL INSTRUCTIONS - Read the resume carefully and follow these rules EXACTLY:

1. ALWAYS USE ACTUAL DETAILS from the resume:
   - Extract and use REAL company names from resume (e.g., "TCS", "Infosys", "Tech Mahindra")
   - Extract and use REAL project names mentioned in resume
   - Extract and use REAL technologies, tools, frameworks mentioned in resume
   - Use EXACT experience years from resume (e.g., "5 years", not "several years")
   - DO NOT fabricate or assume any information not in the resume

2. ANSWER STRUCTURE (follow this template):
   Sentence 1-2: Direct, concise answer to the core question
   Sentence 3-4: Real example from resume using actual project/company names
   Sentence 5-6: Specific outcome, metric, or learning from that experience
   
   Example structure:
   "[Technology] is [definition/explanation]. At [REAL COMPANY NAME], I worked with [REAL TECHNOLOGY] on the [REAL PROJECT NAME] where we [specific action]. This resulted in [real metric/outcome from resume]. The experience taught me [specific learning]."

3. FORBIDDEN PLACEHOLDERS - NEVER use:
   ❌ "[current company]" or "[previous company]"
   ❌ "[specific project]" or "[project name]"
   ❌ "[X years]" or "approximately X years"
   ❌ "In one of my projects..." (be specific!)
   ❌ "At my current company..." (use actual name!)
   ✅ Instead, extract actual names from resume

4. If question is NOT in resume scope:
   - First sentence: "While my resume doesn't detail this specifically, I understand [concept]..."
   - Then provide general technical answer based on industry knowledge
   - Keep it conceptual and honest

5. ANSWER LENGTH & STYLE:
   - Exactly 4-6 sentences
   - Professional, confident, first-person voice
   - Natural conversational tone (as if speaking to interviewer)
   - No jargon unless question asks for technical depth

6. FORMATTING (CRITICAL - FOLLOW EXACTLY):
   - Plain text only - simple, clean sentences
   - ABSOLUTELY NO strikethrough formatting (~~text~~) - this is forbidden
   - ABSOLUTELY NO tildes (~) anywhere in the answer
   - NO code blocks unless coding question
   - NO bullet points or numbered lists in answer text
   - Use **bold** sparingly for emphasis only
   - Write naturally as if speaking to an interviewer

7. QUALITY CHECKLIST before submitting answer:
   ✓ Contains at least one REAL company/project name from resume?
   ✓ Uses specific technologies mentioned in resume?
   ✓ Includes concrete metric or outcome?
   ✓ Sounds authentic and personalized (not generic)?
   ✓ 4-6 sentences in length?
   ✓ No placeholder text?

Return ONLY the answer text - no labels like "Answer:", no JSON, no extra formatting.`;
          } else {
            systemPrompt += `\n\nProvide a professional first-person answer that:
- Uses "I" statements and sounds conversational
- Shows deep understanding with specific examples
- Is suitable for the question's difficulty level`;
          }

          userPrompt = `Question: ${q.question}`;
          
          if (q.reasoning) {
            userPrompt += `\n\nWhy this question: ${q.reasoning}`;
          }
          
          if (q.focusArea) {
            userPrompt += `\n\nFocus Area: ${q.focusArea}`;
          }
          
          if (jobDescriptionText && jobDescriptionText.trim()) {
            userPrompt += `\n\nJob Requirements: ${jobDescriptionText.substring(0, 400)}`;
          }
          
          userPrompt += `\n\nProvide a personalized, authentic answer using REAL details from the resume above:`;
        }

        // Send progress event
        res.write(`data: ${JSON.stringify({
          type: 'progress',
          completed: i,
          total: questions.length
        })}\n\n`);

        let answer = '';
        let retryCount = 0;
        const maxRetries = 2;
        
        // Retry logic for failed requests
        while (retryCount <= maxRetries && !answer) {
          try {
            console.log(`Generating answer ${i + 1}/${questions.length} (attempt ${retryCount + 1})`);
            
            const response = await axios.post(
              `${OPENROUTER_BASE_URL}/chat/completions`,
              {
                model: OPENROUTER_MODEL,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
                ],
                max_tokens: isCodingQuestion ? 1500 : 600,
                temperature: isCodingQuestion ? 0.3 : 0.75,
                top_p: 0.9
              },
              {
                headers: {
                  'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                  'Content-Type': 'application/json'
                },
                timeout: 60000 // Increased timeout to 60 seconds
              }
            );

            answer = response.data.choices[0].message.content.trim();
            
            // Enhanced validation for answer quality
            const hasPlaceholder = answer.includes('[current company]') || 
                                   answer.includes('[previous company]') || 
                                   answer.includes('[specific project]') ||
                                   answer.includes('[project name]');
            
            const isGeneric = !isCodingQuestion && resumeText && 
                             !answer.match(/TCS|Infosys|Tech Mahindra|Wipro|HCL|Accenture/i) &&
                             answer.length < 150;
            
            if (!answer || answer.length < 20) {
              console.warn(`Answer too short for question ${i + 1} (${answer.length} chars), retrying...`);
              answer = '';
              retryCount++;
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }
            
            if (hasPlaceholder) {
              console.warn(`Answer ${i + 1} contains placeholders, retrying...`);
              answer = '';
              retryCount++;
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }
            
            if (isGeneric && retryCount === 0) {
              console.warn(`Answer ${i + 1} seems too generic (no company names), retrying...`);
              answer = '';
              retryCount++;
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }
            
            // Clean up formatting - remove all strikethrough variations
            answer = answer
              .replace(/~~(.+?)~~/gs, '$1') // Remove ~~strikethrough~~ (with global + multiline)
              .replace(/~~/g, '') // Remove any remaining tildes
              .replace(/\*\*\*(.+?)\*\*\*/g, '**$1**') // Fix triple bold
              .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines
              .replace(/_{2,}/g, '') // Remove underline formatting (__text__)
              .trim();
            
            console.log(`✓ Answer ${i + 1} generated successfully (${answer.length} chars, attempt ${retryCount + 1})`);
            break;
            
          } catch (apiError) {
            console.error(`Retry ${retryCount + 1} failed for question ${i + 1}:`, apiError.message);
            
            // Check for payment/credit issues
            if (apiError.response?.status === 402) {
              console.error('❌ API Credits Exhausted - Status 402');
              res.write(`data: ${JSON.stringify({
                type: 'error',
                message: '⚠️ API credits exhausted. Please check your OpenRouter account balance and add credits to continue. Visit: https://openrouter.ai/credits'
              })}\n\n`);
              res.end();
              return;
            }
            
            // Check for rate limiting
            if (apiError.response?.status === 429) {
              console.error('⚠️ Rate limit hit - Status 429');
              await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for rate limit
            }
            
            retryCount++;
            if (retryCount <= maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            }
          }
        }
        
        // If still no answer after retries, generate a fallback
        if (!answer) {
          console.error(`Failed to generate answer for question ${i + 1} after ${maxRetries + 1} attempts`);
          if (isCodingQuestion) {
            answer = `This coding question requires implementing a solution. A strong answer would include:\n\n` +
                    `1. Clear code implementation with proper syntax\n` +
                    `2. Handling of edge cases and input validation\n` +
                    `3. Time and space complexity analysis\n` +
                    `4. Comments explaining the logic\n\n` +
                    `Consider using appropriate data structures and algorithms based on the problem requirements.`;
          } else {
            answer = `This question focuses on ${q.focusArea || 'technical concepts'}. A comprehensive answer would:\n\n` +
                    `1. Explain the core concept clearly\n` +
                    `2. Provide real-world examples or use cases\n` +
                    `3. Discuss trade-offs and best practices\n` +
                    `4. Relate to practical experience\n\n` +
                    `Review the question and prepare specific examples from your experience.`;
          }
        }
        
        const answerObj = {
          question: q.question,
          answer: answer,
          category: q.category || q.focusArea,
          reasoning: q.reasoning
        };
        
        answers.push(answerObj);

        // Send answer event
        res.write(`data: ${JSON.stringify({
          type: 'answer',
          answer: answerObj,
          index: i
        })}\n\n`);

      } catch (error) {
        console.error('Unexpected error for question:', error.message);
        
        // Generate meaningful fallback answer
        let fallbackAnswer = '';
        if (isCodingQuestion) {
          fallbackAnswer = `This coding question requires implementing a solution with clean code, proper error handling, and optimal complexity. Consider the input/output requirements and edge cases when preparing your answer.`;
        } else {
          fallbackAnswer = `This technical question about ${q.focusArea || 'the topic'} requires a clear explanation with practical examples. Focus on demonstrating your understanding through real-world scenarios and best practices.`;
        }
        
        const errorAnswer = {
          question: q.question,
          answer: fallbackAnswer,
          category: q.category || q.focusArea,
          reasoning: q.reasoning
        };
        
        answers.push(errorAnswer);

        // Send error answer event
        res.write(`data: ${JSON.stringify({
          type: 'answer',
          answer: errorAnswer,
          index: i
        })}\n\n`);
      }
    }

    // Send completion event
    res.write(`data: ${JSON.stringify({
      type: 'complete',
      answers: answers
    })}\n\n`);

    res.end();

  } catch (error) {
    console.error('Error in answer generation:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: 'Failed to generate answers'
    })}\n\n`);
    res.end();
  }
});

// Extract text from uploaded resume file
app.post('/api/extract-text', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('Extracting text from file:', req.file.originalname);

    const text = await extractTextFromFile(req.file);
    
    res.json({ text });

  } catch (error) {
    console.error('Error extracting text:', error);
    res.status(500).json({ error: 'Failed to extract text from file' });
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
        resumeText: resumeText, // Include full text for serverless compatibility
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
      resumeText: resumeText, // Include full text for serverless compatibility
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
    const { message, sessionId, mode, resumeData, resumeText, conversationHistory } = req.body;

    console.log('Resume-aware chat request:', {
      hasMessage: !!message,
      messageLength: message?.length || 0,
      hasSessionId: !!sessionId,
      hasResumeData: !!resumeData,
      hasResumeText: !!resumeText,
      resumeTextLength: resumeText?.length || 0,
      conversationLength: conversationHistory?.length || 0
    });

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // For serverless compatibility: Accept resume data from request body OR fallback to in-memory store
    let actualResumeData, fullResumeText;
    
    if (resumeData && resumeText) {
      // Resume data sent with request (serverless-friendly)
      console.log('Using resume data from request body');
      actualResumeData = resumeData;
      fullResumeText = resumeText;
    } else if (sessionId && resumeDataStore.has(sessionId)) {
      // Fallback to in-memory store (local development)
      console.log('Using resume data from session store');
      const resumeSession = resumeDataStore.get(sessionId);
      actualResumeData = resumeSession.data;
      fullResumeText = resumeSession.fullText || '';
    } else {
      console.error('No resume data found - sessionId:', sessionId, 'has data:', !!resumeData);
      return res.status(400).json({ error: 'Resume data is required. Please upload your resume again.' });
    }

    // Validate that we have actual resume data
    if (!actualResumeData || Object.keys(actualResumeData).length === 0) {
      console.error('Resume data is empty or invalid');
      return res.status(400).json({ error: 'Invalid resume data. Please upload your resume again.' });
    }

    console.log('Resume data validated, generating response...');

    // Extract clientId for Windows app sync
    const clientId = req.query.clientId || req.headers['x-client-id'];

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
- Experience: ${actualResumeData.experience?.totalYears || 'Not specified'} years
- Current Role: ${actualResumeData.experience?.currentRole || 'Not specified'}
- Key Technologies: ${[
  ...(actualResumeData.technologies?.languages || []),
  ...(actualResumeData.technologies?.frameworks || []),
  ...(actualResumeData.technologies?.tools || [])
].slice(0, 10).join(', ')}
- Domain Experience: ${(actualResumeData.domain || []).join(', ')}
- Education: ${(actualResumeData.education?.degrees || []).join(', ')}
- Certifications: ${(actualResumeData.education?.certifications || []).join(', ')}

KEY PROJECTS:
${(actualResumeData.projects || []).slice(0, 3).map(p => 
  `- ${p.name}: ${p.description} (${(p.technologies || []).join(', ')})`
).join('\n')}

FULL RESUME CONTEXT (for detailed reference):
${fullResumeText.substring(0, 2000)}${fullResumeText.length > 2000 ? '...' : ''}

INSTRUCTIONS:
When answering interview questions:
1. Give DIRECT, PROFESSIONAL answers - speak as if you ARE the candidate answering the interviewer
2. DO NOT include phrases like "Sure, I'd be happy to explain...", "From what I understand from my resume...", "Based on my experience...", "Let me tell you about..."
3. Start IMMEDIATELY with the core answer - get straight to the technical or professional content
4. Base answers on the candidate's ACTUAL experience and skills from their resume
5. Reference specific projects, technologies, or achievements naturally within the answer
6. Keep answers clear and confident - like a skilled professional explaining their work
7. Keep responses concise (3-5 sentences unless more detail is requested)
8. If the candidate doesn't have direct experience with something, suggest how they could relate their existing experience to it
9. Use first-person perspective naturally ("I designed...", "I implemented...", "We used...") but avoid meta-commentary about answering

ANSWER FORMAT:
❌ BAD: "Sure, I'd be happy to explain Azure Databricks based on my experience. From what I understand from my resume, Azure Databricks is a powerful cloud-based platform..."
✅ GOOD: "Databricks is a powerful cloud-based platform that we used for big data processing and analytics. It's built on Apache Spark..."

Answer style: ${mode === 'detailed' ? 'Provide comprehensive, in-depth answers with examples from their resume' : 'Give brief, clear answers suitable for interview responses'}`;

    // Build conversation messages with history
    const conversationMessages = [
      { role: 'system', content: systemPrompt }
    ];
    
    // Add conversation history if provided (limit to last 6 messages to avoid token limits)
    if (conversationHistory && conversationHistory.length > 0) {
      const recentHistory = conversationHistory.slice(-6);
      for (const msg of recentHistory) {
        conversationMessages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.text
        });
      }
    }
    
    // Add current message
    conversationMessages.push({ role: 'user', content: message });
    
    console.log('Sending to AI with', conversationMessages.length, 'messages');

    // Enable streaming response
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: OPENROUTER_MODEL,
        messages: conversationMessages,
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
        timeout: 45000 // Increased timeout to 45 seconds
      }
    );

    // Set headers for SSE streaming to browser
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullAnswer = '';
    
    // Helper function to clean AI response from special tokens
    const cleanResponse = (text) => {
      if (!text) return '';
      
      // Remove special tokens like <s>, </s>, [INST], [/INST], [OUT], [/OUT]
      let cleaned = text
        .replace(/<s>/g, '')
        .replace(/<\/s>/g, '')
        .replace(/\[INST\]/g, '')
        .replace(/\[\/INST\]/g, '')
        .replace(/\[OUT\]/g, '')
        .replace(/\[\/OUT\]/g, '')
        .replace(/<\|im_start\|>/g, '')
        .replace(/<\|im_end\|>/g, '')
        .replace(/\[ASSISTANT\]/gi, ''); // Remove [ASSISTANT] tags
      
      return cleaned;
    };
    
    // Function to fix garbled text and normalize spacing
    const normalizeText = (text) => {
      if (!text) return '';
      
      // Fix common issues in streaming responses
      let normalized = text
        // Remove multiple spaces
        .replace(/\s+/g, ' ')
        // Fix space before punctuation
        .replace(/\s+([.,!?;:])/g, '$1')
        // Ensure space after punctuation
        .replace(/([.,!?;:])([A-Z])/g, '$1 $2')
        // Fix broken words (e.g., "Ex tract" -> "Extract")
        .replace(/\b(\w)\s+(\w{1,3})\b/g, (match, p1, p2) => {
          // Only merge if second part is very short (likely broken)
          if (p2.length <= 2) return p1 + p2;
          return match;
        })
        .trim();
      
      return normalized;
    };

    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          
          if (data === '[DONE]') {
            // Clean and normalize the full answer
            let finalAnswer = cleanResponse(fullAnswer);
            finalAnswer = normalizeText(finalAnswer);
            
            // Send complete message to Windows app
            if (clientId) {
              broadcastEvent({ 
                role: 'assistant',
                type: 'complete',
                content: finalAnswer,
                isStreaming: false
              }, clientId);
            }
            
            // Send final event to browser
            res.write(`data: ${JSON.stringify({ 
              type: 'complete', 
              content: finalAnswer,
              basedOn: {
                experience: actualResumeData.experience?.totalYears,
                role: actualResumeData.experience?.currentRole,
                technologies: [
                  ...(actualResumeData.technologies?.languages || []),
                  ...(actualResumeData.technologies?.frameworks || [])
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
              // Clean the content before adding to fullAnswer
              const cleanedContent = cleanResponse(content);
              
              if (cleanedContent) {
                // Add content as-is (API handles spacing correctly)
                fullAnswer += cleanedContent;
                
                // Send cleaned chunk to browser
                res.write(`data: ${JSON.stringify({ 
                  type: 'chunk', 
                  content: cleanedContent 
                })}\n\n`);
                
                // Broadcast cleaned chunk to Windows app
                if (clientId) {
                  broadcastEvent({ 
                    role: 'assistant',
                    type: 'chunk',
                    content: cleanedContent,
                    isStreaming: true
                  }, clientId);
                }
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
        // Clean and normalize the full answer
        let finalAnswer = cleanResponse(fullAnswer);
        finalAnswer = normalizeText(finalAnswer);
        
        // Send complete message to Windows app if not already sent
        if (clientId) {
          broadcastEvent({ 
            role: 'assistant',
            type: 'complete',
            content: finalAnswer,
            isStreaming: false
          }, clientId);
        }
        
        res.write(`data: ${JSON.stringify({ 
          type: 'complete', 
          content: finalAnswer,
          basedOn: {
            experience: actualResumeData.experience?.totalYears,
            role: actualResumeData.experience?.currentRole,
            technologies: [
              ...(actualResumeData.technologies?.languages || []),
              ...(actualResumeData.technologies?.frameworks || [])
            ].slice(0, 5)
          }
        })}\n\n`);
        res.end();
      }
    });

    response.data.on('error', (error) => {
      console.error('Stream error:', error);
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        fullAnswerLength: fullAnswer.length
      });
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          message: 'Stream error occurred: ' + error.message 
        })}\n\n`);
        res.end();
      }
    });

    // Add timeout handler
    const timeoutId = setTimeout(() => {
      if (!res.writableEnded) {
        console.error('Response timeout - forcing completion');
        console.error('Timeout details:', {
          fullAnswerLength: fullAnswer.length,
          hasAnswer: fullAnswer.length > 0
        });
        
        if (fullAnswer.length > 0) {
          // If we have partial answer, send it
          res.write(`data: ${JSON.stringify({ 
            type: 'complete', 
            content: cleanResponse(fullAnswer)
          })}\n\n`);
        } else {
          // No answer received
          res.write(`data: ${JSON.stringify({ 
            type: 'complete', 
            content: 'I apologize, but I\'m having trouble generating a response right now. Please try again or rephrase your question.' 
          })}\n\n`);
        }
        res.end();
      }
    }, 50000); // 50 second timeout
    
    // Clear timeout when response completes
    response.data.on('end', () => {
      clearTimeout(timeoutId);
    });

  } catch (error) {
    console.error('Error in resume-aware chat:', error);
    
    // Try to send error via SSE if headers already sent
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          message: 'Failed to generate response. Please try again.' 
        })}\n\n`);
        res.end();
      }
    } else {
      // Send regular error response
      res.status(500).json({ error: 'Failed to generate response. Please try again.' });
    }
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
