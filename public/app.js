const messagesEl = document.getElementById('messages');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const recordBtn = document.getElementById('record');
const toggleModeBtn = document.getElementById('toggle-mode');
const adminBtn = document.getElementById('admin-btn');
const usernameModal = document.getElementById('username-modal');
const usernameInput = document.getElementById('username-input');
const modalSaveBtn = document.getElementById('modal-save-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');

// Client ID management
// DO NOT persist on refresh - always start fresh
let clientId = null; // Removed localStorage.getItem - always null on refresh

// Clear any stored username on page load (session reset)
if (typeof(Storage) !== 'undefined') {
  localStorage.removeItem('clientId');
}

// Update admin button text based on username
function updateAdminButton() {
  if (clientId) {
    adminBtn.textContent = `👤 ${clientId}`;
    adminBtn.classList.add('has-username');
    adminBtn.title = `Logged in as: ${clientId}. Click to change username.`;
  } else {
    adminBtn.textContent = '👤 Guest';
    adminBtn.classList.remove('has-username');
    adminBtn.title = 'Set your username for private sessions';
  }
}

// Show username modal
function showUsernameModal() {
  usernameInput.value = clientId || '';
  usernameModal.style.display = 'block';
  usernameInput.focus();
}

// Hide username modal
function hideUsernameModal() {
  usernameModal.style.display = 'none';
  usernameInput.value = '';
}

// Save username
function saveUsername() {
  const username = usernameInput.value.trim().toLowerCase();
  
  // Validate username (alphanumeric only)
  if (!username) {
    alert('Please enter a username');
    return;
  }
  
  if (!/^[a-z0-9]+$/.test(username)) {
    alert('Username can only contain letters and numbers (no spaces or special characters)');
    return;
  }
  
  if (username.length < 3) {
    alert('Username must be at least 3 characters long');
    return;
  }
  
  // Save to sessionStorage (cleared on refresh/close)
  clientId = username;
  sessionStorage.setItem('clientId', clientId);
  
  // Update UI
  updateAdminButton();
  hideUsernameModal();
  
  // Show notification
  showNotification(`✅ Username set to: ${clientId}`, true);
  
  // Reconnect SSE with new clientId
  reconnectSSE();
}

// Show notification
function showNotification(message, isSuccess = false) {
  const notification = document.createElement('div');
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: ${isSuccess ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.95) 0%, rgba(22, 163, 74, 0.95) 100%)' : 'linear-gradient(135deg, rgba(245, 158, 11, 0.95) 0%, rgba(217, 119, 6, 0.95) 100%)'};
    color: white;
    padding: 12px 24px;
    border-radius: 24px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 1000;
    font-weight: 600;
    animation: slideDown 0.3s ease-out;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideUp 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Event listeners for admin button and modal
adminBtn.addEventListener('click', showUsernameModal);
modalCancelBtn.addEventListener('click', hideUsernameModal);
modalSaveBtn.addEventListener('click', saveUsername);

// Allow Enter key to save in modal
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    saveUsername();
  } else if (e.key === 'Escape') {
    hideUsernameModal();
  }
});

// Initialize admin button
updateAdminButton();

let isSimpleMode = false; // Track current mode

// System prompts for different modes
const detailedSystemPrompt = `You are a friendly technical interview assistant. Provide clear, complete explanations.

**IMPORTANT RULES:**
1. Answer the EXACT question asked - don't provide code unless specifically requested
2. If asked "What is X?" or "Explain X" → Give explanation ONLY, NO CODE
3. If asked "Write code for X" or "Implement X" → Give code ONLY
4. Keep formatting simple - use plain text with minimal Markdown
5. NEVER rollback or delete previous content
6. Complete your full response without stopping mid-sentence

**For EXPLANATION questions (What is, Explain, Define, Tell me about, How does):**

Provide a complete explanation in this simple format:

**[Topic Name]**

[2-3 clear paragraphs explaining the concept in simple language. Use everyday examples and analogies. Make it easy to understand.]

**Why it's useful:**
[1-2 sentences explaining the purpose and importance]

**How it works:**
- [Key point 1 with brief example]
- [Key point 2 with brief example]
- [Key point 3 with brief example]

**Key things to remember:**
- [Important takeaway 1]
- [Important takeaway 2]
- [Common use cases]

For algorithms, mention time/space complexity simply: "This is O(log n) because..."

**For CODE questions (ONLY when they explicitly say "Write", "Code", "Program", "Implement", "Show code"):**

**[Topic Name - Implementation]**

[Brief 1-sentence description]

\`\`\`python
# Complete, working code
# Include ALL necessary functions, classes, and methods
# Add clear comments
# NEVER truncate or use ... to indicate omitted code
# Write the COMPLETE implementation

def function_name(params):
    # Full implementation here
    pass
\`\`\`

**How it works:**
[Explain the code briefly in 2-3 sentences]

**Important:**
- Provide COMPLETE, runnable code
- Include ALL functions and methods
- NO placeholders like "# ... rest of code"
- Write every line needed
- If code is long, write ALL of it anyway

**CRITICAL:**
- Answer ONLY what is asked
- NO code for "What is" questions
- NO explanation for "Write code" questions
- Complete the FULL code without truncation
- Never use ... or ellipsis in code
- Never delete or rollback content`;

const simpleSystemPrompt = `You are a concise technical assistant. Provide SHORT, clear answers with numbered steps.

**IMPORTANT RULES:**
1. Answer ONLY what is asked
2. Keep it SHORT but COMPLETE
3. Use SIMPLE words
4. Use NUMBERED STEPS for how things work
5. NEVER rollback or delete previous content
6. Complete your full response

**RESPONSE FORMAT:**

**Definition:** 
[One clear sentence explaining what it is]

**Simple Explanation:**
[2-3 sentences in very simple words, like explaining to a beginner]

**How it works (Key Steps):**
1. [First step - one simple sentence]
2. [Second step - one simple sentence]
3. [Third step - one simple sentence]
4. [Additional steps if needed]

**Example:**
[One practical, real-world example in simple terms]

**CRITICAL:**
- Be SHORT but COMPLETE
- Use simple language
- Answer ONLY the question asked
- NO code unless requested
- Complete without cutting off`;

let conversation = [
  { role: 'system', content: detailedSystemPrompt }
];

let recognition = null;
let isRecording = false;

// Toggle mode function
function toggleMode() {
  // Ask for confirmation if there are messages (excluding system prompt)
  if (conversation.length > 1) {
    const confirmSwitch = confirm(
      `⚠️ Switching Response Style\n\n` +
      `Current: ${isSimpleMode ? '💡 Simple (Quick answers)' : '📚 Detailed (Long explanations)'}\n` +
      `Switch to: ${isSimpleMode ? '📚 Detailed (Long explanations)' : '💡 Simple (Quick answers)'}\n\n` +
      `This will clear your current chat to avoid confusion.\n\n` +
      `Click OK to switch, or Cancel to keep current mode.`
    );
    
    if (!confirmSwitch) {
      return; // User cancelled
    }
  }
  
  // Toggle the mode
  isSimpleMode = !isSimpleMode;
  
  // Update button appearance and text (removed "Mode" suffix)
  if (isSimpleMode) {
    toggleModeBtn.textContent = '💡 Simple';
    toggleModeBtn.classList.add('simple-mode');
    toggleModeBtn.title = '💡 Simple: Quick answers in bullet points\n📚 Click to switch to Detailed (clears chat)';
    document.body.classList.add('simple-mode');
    // Update system prompt
    conversation[0].content = simpleSystemPrompt;
  } else {
    toggleModeBtn.textContent = '📚 Detailed';
    toggleModeBtn.classList.remove('simple-mode');
    toggleModeBtn.title = '📚 Detailed: Long explanations with examples\n💡 Click to switch to Simple (clears chat)';
    document.body.classList.remove('simple-mode');
    // Update system prompt
    conversation[0].content = detailedSystemPrompt;
  }
  
  // Clear the chat (keep only system prompt)
  conversation.splice(1); // Remove all except system prompt
  messagesEl.innerHTML = ''; // Clear UI
  
  // Add welcome message for the new mode
  const welcomeMsg = document.createElement('div');
  welcomeMsg.className = 'msg';
  welcomeMsg.innerHTML = `
    <div class="assistant">
      <strong>Mode switched to ${isSimpleMode ? '💡 Simple' : '📚 Detailed'}</strong><br><br>
      ${isSimpleMode 
        ? '✅ You\'ll now get <strong>quick, concise answers</strong> in bullet points and numbered steps.<br>Perfect for fast learning!' 
        : '✅ You\'ll now get <strong>comprehensive explanations</strong> with examples and detailed breakdowns.<br>Perfect for deep understanding!'}
    </div>
  `;
  messagesEl.appendChild(welcomeMsg);
  
  // Show notification
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, ${isSimpleMode ? 'rgba(245, 158, 11, 0.95) 0%, rgba(217, 119, 6, 0.95) 100%' : 'rgba(16, 185, 129, 0.95) 0%, rgba(5, 150, 105, 0.95) 100%'});
    color: white;
    padding: 14px 28px;
    border-radius: 24px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 1000;
    font-weight: 600;
    font-size: 15px;
    animation: slideDown 0.3s ease-out;
  `;
  notification.textContent = isSimpleMode 
    ? '💡 Simple Mode Active: Quick & concise answers' 
    : '📚 Detailed Mode Active: Comprehensive explanations';
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideUp 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Add event listener for toggle button
toggleModeBtn.addEventListener('click', toggleMode);

// Simple auto-dismissing voice notification (optimized)
let voiceNotificationTimeout = null;
function showVoiceNotification(message) {
  // Remove existing notification if any
  let notification = document.getElementById('voice-notification');
  
  if (!notification) {
    // Create notification element only once
    notification = document.createElement('div');
    notification.id = 'voice-notification';
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 10000;
      display: none;
    `;
    document.body.appendChild(notification);
  }
  
  // Clear any existing timeout
  if (voiceNotificationTimeout) {
    clearTimeout(voiceNotificationTimeout);
  }
  
  // Update message and show
  notification.textContent = message;
  notification.style.display = 'block';
  notification.style.animation = 'fadeInOut 2s ease-in-out';
  
  // Auto-hide after 2 seconds
  voiceNotificationTimeout = setTimeout(() => {
    notification.style.display = 'none';
  }, 2000);
}

// Technical vocabulary for better speech recognition
const technicalPhrases = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Node.js', 'React', 'Angular', 'Vue.js',
  'Databricks', 'Delta Lake', 'MLflow', 'Unity Catalog', 'Spark SQL', 'Pandas', 'NumPy', 'TensorFlow',
  'AWS', 'Azure', 'Google Cloud', 'Kubernetes', 'Docker', 'API', 'REST', 'GraphQL', 'MongoDB', 'PostgreSQL',
  'Binary Search', 'Linked List', 'Hash Table', 'Recursion', 'Algorithm', 'Machine Learning', 'Neural Network'
];

// Initialize Web Speech API if available
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SpeechGrammarList = window.SpeechGrammarList || window.webkitSpeechGrammarList;
  
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true; // Enable interim results for better UX
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 3; // Get multiple alternatives for better accuracy
  
  // Add technical vocabulary grammar (if supported)
  if (SpeechGrammarList) {
    const grammarList = new SpeechGrammarList();
    const grammar = '#JSGF V1.0; grammar technical; public <term> = ' + technicalPhrases.join(' | ') + ' ;';
    grammarList.addFromString(grammar, 1);
    recognition.grammars = grammarList;
  }

  recognition.onstart = () => {
    isRecording = true;
    recordBtn.textContent = '⏹️ Stop';
    recordBtn.classList.add('recording');
    promptEl.placeholder = '🎤 Listening... (speak now)';
  };

  recognition.onend = () => {
    isRecording = false;
    recordBtn.textContent = '🎤 Voice';
    recordBtn.classList.remove('recording');
    promptEl.placeholder = 'Ask me anything... (e.g., "What is binary search?")';
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';
    
    // Process all results
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }
    
    // Show interim results in the input box
    if (interimTranscript) {
      promptEl.value = interimTranscript;
      promptEl.style.fontStyle = 'italic';
      promptEl.style.opacity = '0.7';
    }
    
    // When final result is available, send it
    if (finalTranscript) {
      promptEl.value = finalTranscript;
      promptEl.style.fontStyle = 'normal';
      promptEl.style.opacity = '1';
      // Auto-send after transcription
      setTimeout(() => send(), 500); // Small delay for user to see the transcription
    }
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isRecording = false;
    recordBtn.textContent = '🎤 Voice';
    recordBtn.classList.remove('recording');
    
    let errorMsg = 'Speech recognition error';
    if (event.error === 'no-speech') {
      errorMsg = 'Voice not recognized';
    } else if (event.error === 'not-allowed') {
      errorMsg = 'Microphone access denied. Please allow microphone access.';
      alert(errorMsg); // Only show alert for permission issues
      return;
    }
    
    // Show simple auto-dismissing notification for voice not recognized
    showVoiceNotification(errorMsg);
  };
}

function render() {
  // Clear only if full re-render is needed
  messagesEl.innerHTML = '';
  conversation.slice(1).forEach(m => {
    const div = document.createElement('div');
    div.className = 'msg';
    // Render content with code blocks properly formatted
    const content = m.content || '';
    const formattedContent = formatContentWithCode(content, m.role);
    div.innerHTML = formattedContent;
    messagesEl.appendChild(div);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Helper function to format content with code blocks while preserving explanation text
function formatContentWithCode(content, role) {
  // Check if content has code blocks
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  
  if (content.match(codeBlockRegex)) {
    // Split content by code blocks but preserve text before and after
    let result = `<div class="${role}"><strong>${role}:</strong> `;
    let lastIndex = 0;
    let match;
    
    // Reset regex for iteration
    codeBlockRegex.lastIndex = 0;
    
    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        const textBefore = content.substring(lastIndex, match.index);
        const htmlBefore = escapeHtml(textBefore).replace(/\n/g, '<br>');
        result += htmlBefore;
      }
      
      // Add code block
      const lang = match[1] || '';
      const code = match[2] || '';
      result += `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`;
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add any remaining text after last code block
    if (lastIndex < content.length) {
      const textAfter = content.substring(lastIndex);
      const htmlAfter = escapeHtml(textAfter).replace(/\n/g, '<br>');
      result += htmlAfter;
    }
    
    result += '</div>';
    return result;
  } else {
    // No code blocks, preserve newlines for plain text
    const html = escapeHtml(content).replace(/\n/g, '<br>');
    return `<div class="${role}"><strong>${role}:</strong> ${html}</div>`;
  }
}

// Optimized render for streaming updates - only update the last message
function updateLastMessage() {
  const lastMsg = conversation[conversation.length - 1];
  if (!lastMsg) return;
  
  // Find or create the last message element
  let lastDiv = messagesEl.lastElementChild;
  if (!lastDiv || lastDiv.children.length === 0) {
    lastDiv = document.createElement('div');
    lastDiv.className = 'msg';
    messagesEl.appendChild(lastDiv);
  }
  
  const content = lastMsg.content || '';
  // Use the same formatting function to preserve explanation with code
  lastDiv.innerHTML = formatContentWithCode(content, lastMsg.role);
  
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Track messages added directly via API to prevent SSE duplication
let lastDirectApiMessage = null;
let currentStreamingMessage = null; // Track currently streaming message

async function send() {
  const text = promptEl.value.trim();
  if (!text) return;
  
  // Add user message to conversation
  conversation.push({ role: 'user', content: text });
  promptEl.value = '';
  render();
  sendBtn.disabled = true;

  // Create placeholder for streaming assistant response
  currentStreamingMessage = { role: 'assistant', content: '' };
  conversation.push(currentStreamingMessage);
  render();

  try {
    // Build URL with clientId if available
    const chatUrl = clientId ? `/api/chat?clientId=${encodeURIComponent(clientId)}` : '/api/chat';
    
    // Send entire conversation history (including system prompt) to API
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Source': 'web-ui',
        ...(clientId && { 'X-Client-ID': clientId }) // Add clientId header if available
      },
      body: JSON.stringify({ messages: conversation.slice(0, -1) }) // Exclude placeholder
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const data = await res.json();
    
    // Parse OpenRouter response format
    let assistantText = '';
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      assistantText = data.choices[0].message.content || '';
    }
    
    // Fallback if no content received
    if (!assistantText || /^\s*$/.test(assistantText)) {
      assistantText = "The assistant did not return a response. Please try again.";
    }

    // Update the streaming placeholder with final content
    // Note: For streaming, this will be updated via SSE events
    // This is just a fallback for non-streaming responses
    if (currentStreamingMessage && currentStreamingMessage.content === '') {
      currentStreamingMessage.content = assistantText;
      currentStreamingMessage = null;
      render();
    } else if (currentStreamingMessage) {
      // SSE already populated it, just clear the reference
      currentStreamingMessage = null;
      render(); // Final render to ensure code highlighting
    }
  } catch (err) {
    console.error('Send error:', err);
    // Remove placeholder and add error
    if (currentStreamingMessage) {
      conversation.pop();
      currentStreamingMessage = null;
    }
    conversation.push({ 
      role: 'assistant', 
      content: 'Error: ' + (err.message || 'Failed to get response') 
    });
    render();
  } finally {
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', send);

recordBtn.addEventListener('click', () => {
  if (!recognition) {
    alert('🎤 Voice input is not supported in your browser.\n\nPlease use:\n- Chrome\n- Edge\n- Safari (iOS)\n\nFirefox does not support speech recognition.');
    return;
  }
  
  if (isRecording) {
    recognition.stop();
  } else {
    try {
      recognition.start();
    } catch (e) {
      console.error('Recognition start error:', e);
      if (e.message.includes('already started')) {
        recognition.stop();
        setTimeout(() => recognition.start(), 100);
      }
    }
  }
});

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

render();

// **ENABLED**: SSE listening for real-time streaming updates
// Listen for server-sent events to get streaming chunks
// SSE connection management
let eventSource = null;
let reconnectInterval = null;
let reconnectAttempts = 0;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }
  
  // Clear any existing reconnect interval
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
    reconnectInterval = null;
  }
  
  // Build URL with clientId if available
  const sseUrl = clientId 
    ? `/events?clientId=${encodeURIComponent(clientId)}&source=web` 
    : '/events?source=web';
  
  if (typeof EventSource !== 'undefined') {
    try {
      eventSource = new EventSource(sseUrl);
      
      eventSource.addEventListener('open', () => {
        console.log('SSE connected successfully');
        reconnectAttempts = 0; // Reset counter on successful connection
      });
      
      eventSource.addEventListener('message', (ev) => {
        try {
          const obj = JSON.parse(ev.data);
          if (obj && obj.role && obj.content) {
            // Handle streaming chunks
            if (obj.type === 'chunk' && obj.isStreaming && currentStreamingMessage) {
              // Append chunk to current streaming message
              currentStreamingMessage.content += obj.content;
              updateLastMessage(); // Only update last message - no flicker!
            }
            // Handle complete message
            else if (obj.type === 'complete' && !obj.isStreaming) {
              // Final message received - already handled by send() function
              console.log('Streaming complete');
            }
            // Handle user message echo (for Windows app sync)
            else if (obj.role === 'user' && !currentStreamingMessage) {
              // Skip user messages from other clients (already added locally)
            }
          }
        } catch (e) {
          console.warn('Failed to parse SSE message', e);
        }
      });
      
      eventSource.addEventListener('error', (e) => {
        console.warn('SSE connection error, attempting reconnect...');
        reconnectAttempts++;
        
        // Close current connection
        if (eventSource) {
          eventSource.close();
        }
        
        // Only reconnect if we have a clientId (private session)
        if (clientId) {
          // Attempt reconnection every 1 second
          if (!reconnectInterval) {
            reconnectInterval = setInterval(() => {
              console.log(`Reconnection attempt ${reconnectAttempts} for user: ${clientId}`);
              connectSSE();
            }, 1000); // Reconnect every 1 second
          }
        }
      });
      
      console.log('SSE connected with URL:', sseUrl);
    } catch (error) {
      console.error('Failed to create EventSource:', error);
      
      // Retry connection for private sessions
      if (clientId && !reconnectInterval) {
        reconnectInterval = setInterval(() => {
          console.log(`Reconnection attempt ${reconnectAttempts} for user: ${clientId}`);
          connectSSE();
        }, 1000);
      }
    }
  }
}

function reconnectSSE() {
  console.log('Reconnecting SSE with new clientId...');
  connectSSE();
}

// Initial SSE connection
connectSSE();

/* ==========================================
   INTERVIEW GENERATOR FUNCTIONALITY
   ========================================== */

// Navigation between Chat and Interview sections
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const section = tab.dataset.section;
    
    // Update tabs
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // Hide all sections
    document.getElementById('chat-section').classList.remove('active');
    document.getElementById('interview-generator').classList.remove('active');
    document.getElementById('rating-section').classList.remove('active');
    document.getElementById('resume-practice-section').classList.remove('active');
    
    // Show selected section
    if (section === 'chat') {
      document.getElementById('chat-section').classList.add('active');
    } else if (section === 'interview') {
      document.getElementById('interview-generator').classList.add('active');
    } else if (section === 'rating') {
      document.getElementById('rating-section').classList.add('active');
    } else if (section === 'resume-practice') {
      document.getElementById('resume-practice-section').classList.add('active');
    }
  });
});

// File upload handling
let resumeFile = null;
let jdFile = null;

// Resume file upload
const resumeInput = document.getElementById('resume-file');
const resumeZone = document.getElementById('resume-upload-zone');
const resumeSelected = document.getElementById('resume-selected');
const resumeFilename = document.getElementById('resume-filename');

resumeZone.addEventListener('click', () => resumeInput.click());

resumeInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    if (validateFile(file, ['pdf', 'docx'], 5)) {
      resumeFile = file;
      resumeFilename.textContent = file.name;
      resumeSelected.classList.add('show');
    }
  }
});

// Drag and drop for resume
resumeZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  resumeZone.classList.add('drag-over');
});

resumeZone.addEventListener('dragleave', () => {
  resumeZone.classList.remove('drag-over');
});

resumeZone.addEventListener('drop', (e) => {
  e.preventDefault();
  resumeZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && validateFile(file, ['pdf', 'docx'], 5)) {
    resumeFile = file;
    resumeInput.files = e.dataTransfer.files;
    resumeFilename.textContent = file.name;
    resumeSelected.classList.add('show');
  }
});

// Job Description file upload
const jdInput = document.getElementById('jd-file');
const jdZone = document.getElementById('jd-upload-zone');
const jdSelected = document.getElementById('jd-selected');
const jdFilename = document.getElementById('jd-filename');

jdZone.addEventListener('click', () => jdInput.click());

jdInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    if (validateFile(file, ['pdf', 'docx', 'txt'], 5)) {
      jdFile = file;
      jdFilename.textContent = file.name;
      jdSelected.classList.add('show');
      // Clear textarea when file is selected
      document.getElementById('job-description').value = '';
    }
  }
});

// Drag and drop for JD
jdZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  jdZone.classList.add('drag-over');
});

jdZone.addEventListener('dragleave', () => {
  jdZone.classList.remove('drag-over');
});

jdZone.addEventListener('drop', (e) => {
  e.preventDefault();
  jdZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && validateFile(file, ['pdf', 'docx', 'txt'], 5)) {
    jdFile = file;
    jdInput.files = e.dataTransfer.files;
    jdFilename.textContent = file.name;
    jdSelected.classList.add('show');
    document.getElementById('job-description').value = '';
  }
});

// File validation
function validateFile(file, allowedExtensions, maxSizeMB) {
  const ext = file.name.split('.').pop().toLowerCase();
  const sizeMB = file.size / (1024 * 1024);
  
  if (!allowedExtensions.includes(ext)) {
    alert(`Invalid file type. Please upload: ${allowedExtensions.map(e => e.toUpperCase()).join(', ')}`);
    return false;
  }
  
  if (sizeMB > maxSizeMB) {
    alert(`File too large. Maximum size is ${maxSizeMB}MB`);
    return false;
  }
  
  return true;
}

// Remove file functions
function removeResumeFile() {
  resumeFile = null;
  resumeInput.value = '';
  resumeSelected.classList.remove('show');
}

function removeJDFile() {
  jdFile = null;
  jdInput.value = '';
  jdSelected.classList.remove('show');
}

// Generate Interview Questions
let currentResults = null;

async function generateQuestions() {
  // Validate inputs
  if (!resumeFile) {
    alert('Please upload a resume');
    return;
  }
  
  const jdText = document.getElementById('job-description').value.trim();
  if (!jdText && !jdFile) {
    alert('Please provide a job description (text or file)');
    return;
  }
  
  // Show loading
  document.getElementById('upload-form').style.display = 'none';
  document.getElementById('loading-state').classList.add('show');
  document.getElementById('results-container').classList.remove('show');
  
  // Prepare FormData
  const formData = new FormData();
  formData.append('resume', resumeFile);
  
  if (jdFile) {
    formData.append('jobDescription', jdFile);
  } else {
    formData.append('jobDescriptionText', jdText);
  }
  
  try {
    const response = await fetch('/api/generate-interview-questions', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate questions');
    }
    
    const data = await response.json();
    currentResults = data;
    
    // Hide loading, show results
    document.getElementById('loading-state').classList.remove('show');
    displayResults(data);
    
  } catch (error) {
    console.error('Error:', error);
    alert(`Error: ${error.message}`);
    document.getElementById('loading-state').classList.remove('show');
    document.getElementById('upload-form').style.display = 'block';
  }
}

// Display results
function displayResults(data) {
  const resultsContainer = document.getElementById('results-container');
  const analysisSummary = document.getElementById('analysis-summary');
  
  // Build analysis summary
  let summaryHTML = '';
  
  if (data.analysis) {
    if (data.analysis.role) {
      summaryHTML += `
        <div class="analysis-item">
          <h4>Target Role</h4>
          <p>${data.analysis.role}</p>
        </div>
      `;
    }
    
    if (data.analysis.experienceLevel) {
      summaryHTML += `
        <div class="analysis-item">
          <h4>Experience Level</h4>
          <p>${data.analysis.experienceLevel}</p>
        </div>
      `;
    }
    
    if (data.analysis.matchingSkills && data.analysis.matchingSkills.length > 0) {
      summaryHTML += `
        <div class="analysis-item" style="grid-column: span 2;">
          <h4>Matching Skills</h4>
          <div class="skills-list">
            ${data.analysis.matchingSkills.map(skill => 
              `<span class="skill-tag">${skill}</span>`
            ).join('')}
          </div>
        </div>
      `;
    }
    
    if (data.analysis.skillGaps && data.analysis.skillGaps.length > 0) {
      summaryHTML += `
        <div class="analysis-item" style="grid-column: span 2;">
          <h4>Skill Gaps to Assess</h4>
          <div class="skills-list">
            ${data.analysis.skillGaps.map(skill => 
              `<span class="skill-tag gap">${skill}</span>`
            ).join('')}
          </div>
        </div>
      `;
    }
  }
  
  analysisSummary.innerHTML = summaryHTML;
  
  // Update question counts
  document.getElementById('basic-count').textContent = data.questions.basic.length;
  document.getElementById('advanced-count').textContent = data.questions.advanced.length;
  document.getElementById('scenario-count').textContent = data.questions.scenario.length;
  
  // Render questions
  renderQuestions('basic', data.questions.basic);
  renderQuestions('advanced', data.questions.advanced);
  renderQuestions('scenario', data.questions.scenario);
  
  // Show results
  resultsContainer.classList.add('show');
  
  // Scroll to results
  resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  
  // Initialize rating dashboard with all generated questions
  const allQuestions = [
    ...data.questions.basic.map(q => ({ ...q, category: 'Basic' })),
    ...data.questions.advanced.map(q => ({ ...q, category: 'Advanced' })),
    ...data.questions.scenario.map(q => ({ ...q, category: 'Scenario' }))
  ];
  initializeRatingDashboard(allQuestions);
}

// Render questions for a category
function renderQuestions(category, questions) {
  const section = document.getElementById(`${category}-section`);
  
  const html = questions.map((q, index) => {
    // Calculate difficulty stars
    let difficultyStars = '';
    const maxStars = 5;
    const filledStars = q.difficulty || (category === 'basic' ? 2 : category === 'advanced' ? 4 : 5);
    
    for (let i = 1; i <= maxStars; i++) {
      difficultyStars += `<span class="star ${i <= filledStars ? '' : 'empty'}">★</span>`;
    }
    
    return `
      <div class="question-card">
        <div class="question-header">
          <div class="question-number">${index + 1}</div>
          <div class="question-category">${category.charAt(0).toUpperCase() + category.slice(1)}</div>
          <div class="question-difficulty" title="Difficulty: ${filledStars}/5">
            ${difficultyStars}
          </div>
        </div>
        
        <div class="question-text">${q.question}</div>
        
        ${q.reasoning ? `
          <div class="question-reasoning">
            <strong>Why This Question?</strong>
            <p>${q.reasoning}</p>
            ${q.focusArea ? `<div class="focus-area">🎯 Focus: ${q.focusArea}</div>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  section.innerHTML = html;
}

// Show question category
function showQuestionCategory(category) {
  // Update tabs
  document.querySelectorAll('.question-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  event.target.closest('.question-tab').classList.add('active');
  
  // Update sections
  document.querySelectorAll('.questions-section').forEach(section => {
    section.classList.remove('active');
  });
  document.getElementById(`${category}-section`).classList.add('active');
}

// Copy all questions
function copyAllQuestions() {
  if (!currentResults) return;
  
  let text = '=== INTERVIEW QUESTIONS ===\n\n';
  
  if (currentResults.analysis) {
    text += '📊 ANALYSIS SUMMARY\n';
    if (currentResults.analysis.role) text += `Role: ${currentResults.analysis.role}\n`;
    if (currentResults.analysis.experienceLevel) text += `Level: ${currentResults.analysis.experienceLevel}\n`;
    text += '\n';
  }
  
  // Basic questions
  text += '📘 BASIC QUESTIONS\n';
  currentResults.questions.basic.forEach((q, i) => {
    text += `\n${i + 1}. ${q.question}\n`;
    if (q.reasoning) text += `   Reasoning: ${q.reasoning}\n`;
  });
  
  // Advanced questions
  text += '\n\n📕 ADVANCED QUESTIONS\n';
  currentResults.questions.advanced.forEach((q, i) => {
    text += `\n${i + 1}. ${q.question}\n`;
    if (q.reasoning) text += `   Reasoning: ${q.reasoning}\n`;
  });
  
  // Scenario questions
  text += '\n\n💡 SCENARIO-BASED QUESTIONS\n';
  currentResults.questions.scenario.forEach((q, i) => {
    text += `\n${i + 1}. ${q.question}\n`;
    if (q.reasoning) text += `   Reasoning: ${q.reasoning}\n`;
  });
  
  // Copy to clipboard
  navigator.clipboard.writeText(text).then(() => {
    alert('✅ All questions copied to clipboard!');
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('❌ Failed to copy to clipboard');
  });
}

// Export to PDF (simplified version - just downloads as text file)
function exportToPDF() {
  if (!currentResults) return;
  
  let text = '=== INTERVIEW QUESTIONS ===\n\n';
  
  if (currentResults.analysis) {
    text += '📊 ANALYSIS SUMMARY\n';
    if (currentResults.analysis.role) text += `Role: ${currentResults.analysis.role}\n`;
    if (currentResults.analysis.experienceLevel) text += `Level: ${currentResults.analysis.experienceLevel}\n`;
    if (currentResults.analysis.matchingSkills) {
      text += `Matching Skills: ${currentResults.analysis.matchingSkills.join(', ')}\n`;
    }
    if (currentResults.analysis.skillGaps) {
      text += `Skill Gaps: ${currentResults.analysis.skillGaps.join(', ')}\n`;
    }
    text += '\n';
  }
  
  // Basic questions
  text += '📘 BASIC QUESTIONS\n';
  currentResults.questions.basic.forEach((q, i) => {
    text += `\n${i + 1}. ${q.question}\n`;
    if (q.reasoning) text += `   Reasoning: ${q.reasoning}\n`;
    if (q.focusArea) text += `   Focus: ${q.focusArea}\n`;
  });
  
  // Advanced questions
  text += '\n\n📕 ADVANCED QUESTIONS\n';
  currentResults.questions.advanced.forEach((q, i) => {
    text += `\n${i + 1}. ${q.question}\n`;
    if (q.reasoning) text += `   Reasoning: ${q.reasoning}\n`;
    if (q.focusArea) text += `   Focus: ${q.focusArea}\n`;
  });
  
  // Scenario questions
  text += '\n\n💡 SCENARIO-BASED QUESTIONS\n';
  currentResults.questions.scenario.forEach((q, i) => {
    text += `\n${i + 1}. ${q.question}\n`;
    if (q.reasoning) text += `   Reasoning: ${q.reasoning}\n`;
    if (q.focusArea) text += `   Focus: ${q.focusArea}\n`;
  });
  
  // Create download
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `interview-questions-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Start new generation
function startNewGeneration() {
  // Reset form
  removeResumeFile();
  removeJDFile();
  document.getElementById('job-description').value = '';
  
  // Hide results, show form
  document.getElementById('results-container').classList.remove('show');
  document.getElementById('upload-form').style.display = 'block';
  
  // Scroll to top
  document.querySelector('.interview-content').scrollTo({ top: 0, behavior: 'smooth' });
}

// Make functions globally accessible
window.showQuestionCategory = showQuestionCategory;
window.copyAllQuestions = copyAllQuestions;
// Store generated answers
let generatedAnswers = null;

// Generate answers for all questions
async function generateAnswers() {
  if (!currentResults || !currentResults.questions) {
    alert('Please generate questions first');
    return;
  }

  // Collect all questions
  const allQuestions = [
    ...currentResults.questions.basic.map(q => ({ ...q, category: 'Basic' })),
    ...currentResults.questions.advanced.map(q => ({ ...q, category: 'Advanced' })),
    ...currentResults.questions.scenario.map(q => ({ ...q, category: 'Scenario' }))
  ];

  console.log('Generating answers for', allQuestions.length, 'questions');

  // Show loading
  document.getElementById('answers-loading').classList.add('show');
  document.getElementById('generate-answers-btn').disabled = true;
  document.getElementById('generate-answers-btn').textContent = '⏳ Generating...';

  try {
    const response = await fetch('/api/generate-answers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        questions: allQuestions
      })
    });

    if (!response.ok) {
      throw new Error('Failed to generate answers');
    }

    const data = await response.json();
    generatedAnswers = data.answers;

    // Hide loading
    document.getElementById('answers-loading').classList.remove('show');
    
    // Display answers in the questions
    displayAnswersInQuestions(data.answers);

    // Show download button
    document.getElementById('download-qa-btn').style.display = 'block';
    document.getElementById('generate-answers-btn').textContent = '✅ Answers Generated';
    
    alert('✅ Answers generated successfully! You can now download the Q&A document.');

  } catch (error) {
    console.error('Error generating answers:', error);
    alert('❌ Failed to generate answers. Please try again.');
    document.getElementById('answers-loading').classList.remove('show');
    document.getElementById('generate-answers-btn').disabled = false;
    document.getElementById('generate-answers-btn').textContent = '💡 Generate Answers';
  }
}

// Display answers within question cards
function displayAnswersInQuestions(answers) {
  answers.forEach((qa, index) => {
    // Find the question card
    const allCards = document.querySelectorAll('.question-card');
    if (allCards[index]) {
      // Check if answer already exists
      let answerDiv = allCards[index].querySelector('.question-answer');
      if (!answerDiv) {
        answerDiv = document.createElement('div');
        answerDiv.className = 'question-answer';
        allCards[index].appendChild(answerDiv);
      }
      
      answerDiv.innerHTML = `
        <strong>💡 Model Answer</strong>
        <p>${qa.answer}</p>
      `;
    }
  });
}

// Download questions and answers as a text file
function downloadQuestionsAndAnswers() {
  if (!currentResults || !generatedAnswers) {
    alert('Please generate answers first');
    return;
  }

  let content = '=== INTERVIEW QUESTIONS & ANSWERS ===\n\n';
  content += `Generated: ${new Date().toLocaleString()}\n\n`;

  // Add analysis summary
  if (currentResults.analysis) {
    content += '📊 ANALYSIS SUMMARY\n';
    content += '─'.repeat(50) + '\n';
    if (currentResults.analysis.role) content += `Role: ${currentResults.analysis.role}\n`;
    if (currentResults.analysis.experienceLevel) content += `Level: ${currentResults.analysis.experienceLevel}\n`;
    if (currentResults.analysis.matchingSkills && currentResults.analysis.matchingSkills.length > 0) {
      content += `Matching Skills: ${currentResults.analysis.matchingSkills.join(', ')}\n`;
    }
    if (currentResults.analysis.skillGaps && currentResults.analysis.skillGaps.length > 0) {
      content += `Skill Gaps: ${currentResults.analysis.skillGaps.join(', ')}\n`;
    }
    content += '\n';
  }

  // Add questions and answers by category
  const categories = [
    { name: 'BASIC', questions: currentResults.questions.basic },
    { name: 'ADVANCED', questions: currentResults.questions.advanced },
    { name: 'SCENARIO-BASED', questions: currentResults.questions.scenario }
  ];

  let answerIndex = 0;
  categories.forEach(cat => {
    content += `\n${'='.repeat(50)}\n`;
    content += `📘 ${cat.name} QUESTIONS\n`;
    content += `${'='.repeat(50)}\n\n`;

    cat.questions.forEach((q, i) => {
      const answer = generatedAnswers[answerIndex];
      answerIndex++;

      content += `${i + 1}. QUESTION:\n`;
      content += `   ${q.question}\n\n`;
      
      if (q.reasoning) {
        content += `   💭 Why this question?\n`;
        content += `   ${q.reasoning}\n\n`;
      }

      if (answer && answer.answer) {
        content += `   💡 MODEL ANSWER:\n`;
        content += `   ${answer.answer}\n\n`;
      }

      content += `   Focus Area: ${q.focusArea || 'General'}\n`;
      content += `\n${'-'.repeat(50)}\n\n`;
    });
  });

  // Create download
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `interview-qa-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log('Downloaded Q&A document');
}

// ============================================
// RATING DASHBOARD FUNCTIONALITY
// ============================================

let currentSessionId = null;
let sessionRatings = {};

// Initialize rating dashboard when questions are generated
function initializeRatingDashboard(questions) {
  currentSessionId = 'session_' + Date.now();
  sessionRatings = {};
  
  // Store questions on server
  fetch('/api/store-questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: currentSessionId,
      questions: questions
    })
  }).then(res => res.json())
    .then(data => {
      console.log('Questions stored for rating:', data);
      updateSessionInfo(questions.length);
    })
    .catch(err => console.error('Failed to store questions:', err));
  
  // Render questions in rating dashboard
  renderRatingQuestions(questions);
}

function updateSessionInfo(totalQuestions) {
  const sessionInfo = document.getElementById('session-info');
  if (sessionInfo) {
    sessionInfo.textContent = `Session ID: ${currentSessionId} | Total Questions: ${totalQuestions}`;
  }
}

function renderRatingQuestions(questions) {
  const container = document.getElementById('questions-rating-list');
  if (!container) return;
  
  container.innerHTML = '';
  
  questions.forEach((q, index) => {
    const div = document.createElement('div');
    div.className = 'rating-question-item';
    div.innerHTML = `
      <div class="rating-question-header">
        <span style="font-weight: 600; color: #667eea;">Question ${index + 1}</span>
        <span style="font-size: 12px; color: #666;">
          ${q.category || q.focusArea || 'General'} | 
          Level: ${q.difficulty || q.level || 'Unknown'}
        </span>
      </div>
      <div class="rating-question-text">${q.question}</div>
      ${q.reasoning ? `<div style="font-size: 14px; color: #666; margin-top: 8px;">💭 ${q.reasoning}</div>` : ''}
      <div class="rating-stars" data-index="${index}">
        ${[1, 2, 3, 4, 5].map(star => `
          <span class="star empty" data-star="${star}" onclick="rateQuestion(${index}, ${star})">⭐</span>
        `).join('')}
      </div>
      <div style="margin-top: 8px; font-size: 14px; color: #764ba2; font-weight: 600;" id="rating-display-${index}">
        Not rated yet
      </div>
    `;
    container.appendChild(div);
  });
  
  // Show action buttons
  document.getElementById('rating-actions').style.display = 'flex';
}

function rateQuestion(questionIndex, rating) {
  // Update rating
  sessionRatings[questionIndex] = rating;
  
  // Update stars display
  const starsContainer = document.querySelector(`.rating-stars[data-index="${questionIndex}"]`);
  if (starsContainer) {
    const stars = starsContainer.querySelectorAll('.star');
    stars.forEach((star, index) => {
      if (index < rating) {
        star.classList.remove('empty');
        star.classList.add('filled');
      } else {
        star.classList.remove('filled');
        star.classList.add('empty');
      }
    });
  }
  
  // Update rating display text
  const display = document.getElementById(`rating-display-${questionIndex}`);
  if (display) {
    display.textContent = `Rated: ${'⭐'.repeat(rating)} (${rating}/5)`;
    display.style.color = '#fbbf24';
  }
  
  console.log(`Question ${questionIndex} rated: ${rating} stars`);
}

function saveRatings() {
  if (!currentSessionId) {
    alert('No active session. Please generate questions first.');
    return;
  }
  
  const ratedCount = Object.keys(sessionRatings).length;
  if (ratedCount === 0) {
    alert('Please rate at least one question before saving.');
    return;
  }
  
  fetch('/api/save-ratings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: currentSessionId,
      ratings: sessionRatings
    })
  })
  .then(res => res.json())
  .then(data => {
    alert(`✅ Ratings saved successfully!\n\nTotal questions rated: ${data.totalRated}`);
    console.log('Ratings saved:', data);
  })
  .catch(err => {
    alert('❌ Failed to save ratings. Please try again.');
    console.error('Error saving ratings:', err);
  });
}

function generateReport() {
  if (!currentSessionId) {
    alert('No active session. Please generate questions first.');
    return;
  }
  
  fetch(`/api/rating-report/${currentSessionId}`)
    .then(res => res.json())
    .then(data => {
      displayReport(data);
    })
    .catch(err => {
      alert('❌ Failed to generate report. Please try again.');
      console.error('Error generating report:', err);
    });
}

function displayReport(report) {
  // Update summary stats
  document.getElementById('report-total').textContent = report.summary.totalQuestions;
  document.getElementById('report-rated').textContent = report.summary.totalRated;
  document.getElementById('report-average').textContent = report.summary.overallAverage.toFixed(2);
  document.getElementById('report-progress').textContent = report.summary.ratingPercentage + '%';
  
  // Display level breakdown
  const levelStatsContainer = document.getElementById('level-stats');
  levelStatsContainer.innerHTML = '';
  
  Object.keys(report.levelBreakdown).forEach(level => {
    const stats = report.levelBreakdown[level];
    const div = document.createElement('div');
    div.className = 'level-stat-item';
    div.innerHTML = `
      <div>
        <span class="level-name">${level}</span>
        <span style="margin-left: 12px; color: #666;">
          (${stats.rated}/${stats.total} rated)
        </span>
      </div>
      <div class="level-average">
        ${stats.average > 0 ? '⭐ ' + stats.average : 'Not rated'}
      </div>
    `;
    levelStatsContainer.appendChild(div);
  });
  
  // Display detailed question list
  const detailedList = document.getElementById('detailed-list');
  detailedList.innerHTML = '';
  
  report.questions.forEach((q, index) => {
    const div = document.createElement('div');
    div.className = 'detail-question-item';
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div style="flex: 1;">
          <strong>Q${index + 1}:</strong> ${q.question}
          <div style="font-size: 12px; color: #666; margin-top: 4px;">
            ${q.category || q.focusArea} | Level: ${q.difficulty || q.level}
          </div>
        </div>
        <div class="detail-rating">
          ${q.isRated ? '⭐'.repeat(q.rating) + ` (${q.rating}/5)` : '❌ Not rated'}
        </div>
      </div>
    `;
    detailedList.appendChild(div);
  });
  
  // Show report
  document.getElementById('rating-report').style.display = 'block';
  
  // Scroll to report
  document.getElementById('rating-report').scrollIntoView({ behavior: 'smooth' });
}

function downloadReport() {
  if (!currentSessionId) {
    alert('No report to download.');
    return;
  }
  
  fetch(`/api/rating-report/${currentSessionId}`)
    .then(res => res.json())
    .then(report => {
      let content = '📊 INTERVIEWER RATING REPORT\n';
      content += '='.repeat(60) + '\n\n';
      
      content += `Session ID: ${report.sessionId}\n`;
      content += `Generated on: ${new Date().toLocaleString()}\n\n`;
      
      content += '📈 OVERALL SUMMARY\n';
      content += '-'.repeat(60) + '\n';
      content += `Total Questions: ${report.summary.totalQuestions}\n`;
      content += `Questions Rated: ${report.summary.totalRated}\n`;
      content += `Overall Average Rating: ${report.summary.overallAverage}/5.0 ⭐\n`;
      content += `Rating Progress: ${report.summary.ratingPercentage}%\n\n`;
      
      content += '📊 BREAKDOWN BY DIFFICULTY LEVEL\n';
      content += '-'.repeat(60) + '\n';
      Object.keys(report.levelBreakdown).forEach(level => {
        const stats = report.levelBreakdown[level];
        content += `${level}:\n`;
        content += `  - Total: ${stats.total} questions\n`;
        content += `  - Rated: ${stats.rated} questions\n`;
        content += `  - Average: ${stats.average > 0 ? stats.average + '/5.0 ⭐' : 'Not rated'}\n\n`;
      });
      
      content += '📝 DETAILED QUESTION RATINGS\n';
      content += '-'.repeat(60) + '\n\n';
      report.questions.forEach((q, index) => {
        content += `Question ${index + 1}:\n`;
        content += `${q.question}\n`;
        content += `Category: ${q.category || q.focusArea}\n`;
        content += `Level: ${q.difficulty || q.level}\n`;
        content += `Rating: ${q.isRated ? '⭐'.repeat(q.rating) + ` (${q.rating}/5)` : 'Not rated'}\n`;
        content += '\n' + '-'.repeat(60) + '\n\n';
      });
      
      // Download
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Rating_Report_${currentSessionId}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('Downloaded rating report');
    })
    .catch(err => {
      alert('❌ Failed to download report.');
      console.error('Error downloading report:', err);
    });
}

function clearReport() {
  document.getElementById('rating-report').style.display = 'none';
}

// ============================================
// (OLD RESUME-AWARE CODE REMOVED - NOW IN SEPARATE "Resume-Aware Practice" TAB)
// ============================================

// Expose functions globally
window.rateQuestion = rateQuestion;
window.saveRatings = saveRatings;
window.generateReport = generateReport;
window.downloadReport = downloadReport;
window.clearReport = clearReport;

window.exportToPDF = exportToPDF;
window.startNewGeneration = startNewGeneration;
window.removeResumeFile = removeResumeFile;
window.removeJDFile = removeJDFile;
window.generateQuestions = generateQuestions;
window.generateAnswers = generateAnswers;
window.downloadQuestionsAndAnswers = downloadQuestionsAndAnswers;

// ============================================
// RESUME-AWARE INTERVIEW PRACTICE (STANDALONE)
// ============================================

let practiceSessionId = null;
let practiceResumeData = null;
let practiceMode = 'detailed';
let practiceMessages = [];
let currentInputMethod = 'upload'; // 'upload' or 'paste'
let practiceClientId = null; // For Windows app sync
let practiceRecognition = null; // Speech recognition for practice
let isPracticeRecording = false;

// Initialize speech recognition for Resume-Aware Practice (same as Chat Assistant)
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  // Create recognition instance
  practiceRecognition = new SpeechRecognition();
  practiceRecognition.continuous = false;
  practiceRecognition.interimResults = true; // Enable interim results for better UX
  practiceRecognition.lang = 'en-US';
  practiceRecognition.maxAlternatives = 3; // Get multiple alternatives for better accuracy
  
  // Technical vocabulary for better speech recognition (optional)
  const techVocabulary = ['JavaScript', 'Python', 'React', 'Node.js', 'MongoDB', 'SQL', 'API', 'Docker', 'AWS', 'Git', 'TypeScript', 'Vue', 'Angular'];
  if ('SpeechGrammarList' in window) {
    const grammarList = new window.SpeechGrammarList();
    const grammar = '#JSGF V1.0; grammar tech; public <tech> = ' + techVocabulary.join(' | ') + ' ;';
    grammarList.addFromString(grammar, 1);
    practiceRecognition.grammars = grammarList;
  }
  
  practiceRecognition.onstart = () => {
    console.log('Practice voice recognition started');
    isPracticeRecording = true;
    const recordBtn = document.getElementById('practice-record');
    if (recordBtn) {
      recordBtn.classList.add('recording');
      recordBtn.textContent = '⏹️ Stop';
      recordBtn.title = 'Click to stop recording';
    }
  };
  
  practiceRecognition.onend = () => {
    console.log('Practice voice recognition ended');
    isPracticeRecording = false;
    const recordBtn = document.getElementById('practice-record');
    if (recordBtn) {
      recordBtn.classList.remove('recording');
      recordBtn.textContent = '🎤 Voice';
      recordBtn.title = 'Click to start voice recording';
    }
  };
  
  practiceRecognition.onresult = (event) => {
    console.log('Practice recognition result received');
    let interimTranscript = '';
    let finalTranscript = '';
    
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;
      
      // Log alternatives for debugging
      if (result.length > 1) {
        console.log('Alternatives:', Array.from(result).map(alt => ({
          text: alt.transcript,
          confidence: alt.confidence
        })));
      }
      
      if (result.isFinal) {
        finalTranscript += transcript;
        console.log('Final transcript:', finalTranscript);
      } else {
        interimTranscript += transcript;
        console.log('Interim transcript:', interimTranscript);
      }
    }
    
    const practiceInput = document.getElementById('practice-input');
    if (practiceInput) {
      if (finalTranscript) {
        practiceInput.value = finalTranscript;
        practiceInput.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (interimTranscript) {
        practiceInput.value = interimTranscript;
      }
    }
  };
  
  practiceRecognition.onerror = (event) => {
    console.error('Practice speech recognition error:', event.error);
    isPracticeRecording = false;
    const recordBtn = document.getElementById('practice-record');
    if (recordBtn) {
      recordBtn.classList.remove('recording');
      recordBtn.textContent = '🎤 Voice';
      recordBtn.title = 'Click to start voice recording';
    }
    
    let errorMsg = 'Speech recognition error';
    switch (event.error) {
      case 'no-speech':
        errorMsg = '🎤 No speech detected. Please try again.';
        break;
      case 'audio-capture':
        errorMsg = '🎤 No microphone found. Please check your microphone.';
        break;
      case 'not-allowed':
        errorMsg = '🎤 Microphone access denied. Please allow microphone access in your browser settings.';
        break;
      case 'network':
        errorMsg = '🎤 Network error. Please check your internet connection.';
        break;
      case 'aborted':
        // User stopped recording - not an error
        return;
      default:
        errorMsg = `🎤 Recognition error: ${event.error}`;
    }
    
    if (event.error !== 'aborted') {
      alert(errorMsg);
    }
  };
  
  console.log('Practice speech recognition initialized');
} else {
  console.log('Practice speech recognition not supported');
}

// Show username prompt for Resume-Aware Practice
function showPracticeUsernamePrompt() {
  const username = prompt('👤 Enter your username:\n\nThis will sync your messages with the Windows Voice App.\n\nRequirements:\n• 3-20 characters\n• Letters and numbers only\n• No spaces or special characters');
  
  if (!username) return;
  
  // Validate username
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 20) {
    alert('❌ Username must be 3-20 characters long.');
    return;
  }
  
  if (!/^[a-zA-Z0-9]+$/.test(trimmed)) {
    alert('❌ Username can only contain letters and numbers (no spaces or special characters).');
    return;
  }
  
  // Set username
  practiceClientId = trimmed;
  
  // Update UI
  document.getElementById('practice-guest-btn').style.display = 'none';
  document.getElementById('practice-username-display').style.display = 'flex';
  document.getElementById('practice-current-username').textContent = practiceClientId;
  document.getElementById('practice-username-status').textContent = 
    `✅ Connected as "${practiceClientId}" - Messages will appear in Windows Voice App`;
  
  console.log('Resume Practice username set:', practiceClientId);
}

// Switch between upload and paste methods
function switchInputMethod(method) {
  currentInputMethod = method;
  
  // Update button states
  document.getElementById('upload-method-btn').classList.toggle('active', method === 'upload');
  document.getElementById('paste-method-btn').classList.toggle('active', method === 'paste');
  
  // Toggle visibility
  document.getElementById('file-upload-option').style.display = method === 'upload' ? 'block' : 'none';
  document.getElementById('text-paste-option').style.display = method === 'paste' ? 'block' : 'none';
}

// Clear resume text
function clearResumeText() {
  document.getElementById('practice-resume-text').value = '';
}

// Submit resume text
async function submitResumeText() {
  const textarea = document.getElementById('practice-resume-text');
  const resumeText = textarea.value.trim();
  
  if (!resumeText) {
    alert('⚠️ Please paste your resume text first.');
    return;
  }
  
  if (resumeText.length < 100) {
    alert('⚠️ Resume text seems too short. Please provide more details about your experience, skills, and projects.');
    return;
  }
  
  try {
    // Show loading state
    const submitBtn = event.target;
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Analyzing...';
    
    const response = await fetch('/api/parse-resume-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText })
    });
    
    if (!response.ok) {
      throw new Error('Failed to parse resume text');
    }
    
    const result = await response.json();
    practiceSessionId = result.sessionId;
    practiceResumeData = result.resumeData;
    
    // Update UI
    document.getElementById('practice-resume-upload').style.display = 'none';
    document.getElementById('practice-chat-section').style.display = 'block';
    
    document.getElementById('practice-role').textContent = result.summary.role;
    document.getElementById('practice-experience').textContent = `${result.summary.experience} years`;
    
    const techTags = document.getElementById('practice-tech-tags');
    techTags.innerHTML = '';
    (result.summary.technologies || []).forEach(tech => {
      const tag = document.createElement('span');
      tag.className = 'tech-tag';
      tag.textContent = tech;
      techTags.appendChild(tag);
    });
    
    document.getElementById('practice-resume-info').style.display = 'block';
    
    alert('✅ Resume text analyzed! Now you can start practicing interview questions.');
    
  } catch (error) {
    console.error('Error submitting resume text:', error);
    alert('❌ Failed to analyze resume text. Please try again.');
    
    // Reset button
    const submitBtn = event.target;
    submitBtn.disabled = false;
    submitBtn.textContent = '✅ Submit Resume Text';
  }
}

// Upload resume for practice
async function uploadPracticeResume() {
  const fileInput = document.getElementById('practice-resume-file');
  const file = fileInput.files[0];
  
  if (!file) return;
  
  // Validate file
  const validTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!validTypes.includes(file.type)) {
    alert('❌ Please upload a PDF or DOCX file.');
    return;
  }
  
  if (file.size > 5 * 1024 * 1024) {
    alert('❌ File size must be less than 5MB.');
    return;
  }
  
  try {
    const formData = new FormData();
    formData.append('resume', file);
    
    const response = await fetch('/api/parse-resume', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      throw new Error('Failed to parse resume');
    }
    
    const result = await response.json();
    practiceSessionId = result.sessionId;
    practiceResumeData = result.resumeData;
    
    // Update UI
    document.getElementById('practice-resume-upload').style.display = 'none';
    document.getElementById('practice-chat-section').style.display = 'block';
    
    document.getElementById('practice-role').textContent = result.summary.role;
    document.getElementById('practice-experience').textContent = `${result.summary.experience} years`;
    
    const techTags = document.getElementById('practice-tech-tags');
    techTags.innerHTML = '';
    (result.summary.technologies || []).forEach(tech => {
      const tag = document.createElement('span');
      tag.className = 'tech-tag';
      tag.textContent = tech;
      techTags.appendChild(tag);
    });
    
    document.getElementById('practice-resume-info').style.display = 'block';
    
    alert('✅ Resume loaded! Now you can start practicing interview questions.');
    
  } catch (error) {
    console.error('Error uploading resume:', error);
    alert('❌ Failed to analyze resume. Please try again.');
  }
}

// Send practice message
async function sendPracticeMessage() {
  const input = document.getElementById('practice-input');
  const message = input.value.trim();
  
  if (!message) return;
  if (!practiceSessionId) {
    alert('⚠️ Please upload your resume first.');
    return;
  }
  
  // Add user message
  addPracticeMessage(message, 'user');
  input.value = '';
  
  // Disable send button
  const sendBtn = document.getElementById('practice-send-btn');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Generating... ⏳';
  
  // Create placeholder for streaming response
  const container = document.getElementById('practice-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'practice-message assistant streaming';
  
  const badge = document.createElement('div');
  badge.className = 'resume-badge';
  badge.textContent = '⭐ Resume-Based';
  messageDiv.appendChild(badge);
  
  const contentSpan = document.createElement('span');
  messageDiv.appendChild(contentSpan);
  container.appendChild(messageDiv);
  
  try {
    // Build URL with practiceClientId for Windows app sync
    let url = '/api/chat-with-resume';
    if (practiceClientId) {
      url += `?clientId=${encodeURIComponent(practiceClientId)}`;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-client-id': practiceClientId || ''
      },
      body: JSON.stringify({
        message: message,
        sessionId: practiceSessionId,
        mode: practiceMode
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to get response');
    }
    
    // Handle streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.type === 'chunk' && data.content) {
              fullText += data.content;
              contentSpan.textContent = fullText;
              container.scrollTop = container.scrollHeight;
            } else if (data.type === 'complete') {
              fullText = data.content;
              contentSpan.textContent = fullText;
              messageDiv.classList.remove('streaming');
              container.scrollTop = container.scrollHeight;
              practiceMessages.push({ role: 'assistant', text: fullText, isResumeAware: true });
            } else if (data.type === 'error') {
              contentSpan.textContent = '❌ Error generating response';
              messageDiv.classList.remove('streaming');
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Error:', error);
    contentSpan.textContent = '❌ Sorry, there was an error. Please try again.';
    messageDiv.classList.remove('streaming');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send 📤';
  }
}

// Add message to practice chat
function addPracticeMessage(text, role, isResumeAware = false) {
  const container = document.getElementById('practice-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `practice-message ${role}`;
  
  if (isResumeAware) {
    const badge = document.createElement('div');
    badge.className = 'resume-badge';
    badge.textContent = '⭐ Resume-Based';
    messageDiv.appendChild(badge);
  }
  
  const textNode = document.createTextNode(text);
  messageDiv.appendChild(textNode);
  
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;
  
  practiceMessages.push({ role, text, isResumeAware });
}

// Set practice mode
function setPracticeMode(mode) {
  practiceMode = mode;
  
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  if (mode === 'detailed') {
    document.getElementById('practice-detailed-btn').classList.add('active');
  } else {
    document.getElementById('practice-simple-btn').classList.add('active');
  }
}

// Ask example question
function askExample(question) {
  document.getElementById('practice-input').value = question;
  sendPracticeMessage();
}

// Remove practice resume
function removePracticeResume() {
  if (!confirm('Remove resume and clear chat history?')) {
    return;
  }
  
  practiceSessionId = null;
  practiceResumeData = null;
  practiceMessages = [];
  
  document.getElementById('practice-resume-upload').style.display = 'block';
  document.getElementById('practice-chat-section').style.display = 'none';
  document.getElementById('practice-resume-info').style.display = 'none';
  document.getElementById('practice-messages').innerHTML = '';
  document.getElementById('practice-resume-file').value = '';
}

// Initialize practice resume upload
document.addEventListener('DOMContentLoaded', () => {
  const practiceFileInput = document.getElementById('practice-resume-file');
  const practiceZone = document.getElementById('practice-resume-zone');
  
  if (practiceZone) {
    practiceZone.addEventListener('click', () => practiceFileInput.click());
  }
  
  if (practiceFileInput) {
    practiceFileInput.addEventListener('change', uploadPracticeResume);
  }
  
  // Practice voice record button
  const practiceRecordBtn = document.getElementById('practice-record');
  if (practiceRecordBtn) {
    practiceRecordBtn.addEventListener('click', () => {
      if (!practiceRecognition) {
        alert('🎤 Voice input is not supported in your browser.\n\nPlease use:\n- Chrome\n- Edge\n- Safari (iOS)\n\nFirefox does not support speech recognition.');
        return;
      }
      
      if (isPracticeRecording) {
        practiceRecognition.stop();
      } else {
        try {
          practiceRecognition.start();
        } catch (e) {
          console.error('Practice recognition start error:', e);
          if (e.message.includes('already started')) {
            practiceRecognition.stop();
            setTimeout(() => practiceRecognition.start(), 100);
          }
        }
      }
    });
  }
  
  // Enter key in practice input
  const practiceInput = document.getElementById('practice-input');
  if (practiceInput) {
    practiceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPracticeMessage();
      }
    });
  }
});

// Expose functions globally
window.sendPracticeMessage = sendPracticeMessage;
window.setPracticeMode = setPracticeMode;
window.askExample = askExample;
window.removePracticeResume = removePracticeResume;
window.switchInputMethod = switchInputMethod;
window.submitResumeText = submitResumeText;
window.clearResumeText = clearResumeText;
window.showPracticeUsernamePrompt = showPracticeUsernamePrompt;
