const { queryGemini } = require('../geminiApi');
const Staff = require('../models/Staff');
const StaffTimetable = require('../models/StaffTimetable');
const Appointment = require('../models/Appointment');
const staffProfiles = require('../staff-profiles');

class ClaraAI {
  constructor() {
    this.staffCache = new Map();
    this.timetableCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    this.isDemoMode = false;
    this.currentCallRequest = null;
    this.onlineStaffChecker = null; // Function to check if staff is online
  }

  /**
   * Set the function to check staff online status
   * @param {Function} checker - Function that takes staff email/shortName and returns boolean
   */
  setOnlineStaffChecker(checker) {
    this.onlineStaffChecker = checker;
  }

  // Routing: build powerful system prompt
  buildRoutingPrompt() {
    return `You are Clara, the receptionist AI for Sai Vidya Institute of Technology. Your job is to ROUTE every message to either DEMO mode (college-related assistant with tasking) or AI mode (general knowledge), and produce a structured control object plus a natural reply.

ROUTING POLICY:
- DEMO mode when the user asks ANYTHING about the college (“clg” also means college) including:
  - Admissions, courses, branches, departments, subjects, fees, scholarships, placements, facilities, timings, address, events
  - Staff/faculty/teachers/professors, timetable, schedules, availability, office hours
  - Calling/connecting/meeting staff, appointments, contacting departments, administrative processes
  - Campus life, canteen, library, transport, hostels, rules, forms, maps, directions
- AI mode for everything else (math, coding, world/general knowledge, personal chit-chat not about college, etc.)

INTENT TAXONOMY (use most specific):
- greeting
- staff_info_query
- timetable_query
- availability_query
- schedule_call
- schedule_appointment
- admissions_info
- fees_info
- placements_info
- facilities_info
- general_college_info
- general_knowledge
- general_query

STAFF DETECTION:
- Fuzzy match names and honorifics (e.g., “Anitha mam”, “Prof. Lakshmi”, “Bhavya ma’am”, “Dr. Dhivyasri”).
- If ambiguous, set staff.name = null and request clarification in response_text.
- If user says “teacher of X” without a name, set staff.hint = "teacher_of_X" and request name.

ACTIONS IN DEMO MODE:
- If intent = schedule_call and staff is identified → set action = "initiate_call" and call_request = true.
- If intent = availability_query or timetable_query → set action = "check_availability" and include the time if provided (normalized to 24h, include timezone if present).
- If user explicitly asks to “call/connect/talk/speak” a teacher → treat as schedule_call even if phrased loosely.
- If admissions/fees/placements/facilities/general_college_info → set action = "answer_from_college_knowledge".
- Keep responses brief, warm, and professional. Ask a single clarifying question if needed.

ACTIONS IN AI MODE:
- action = "answer_general" with a concise, accurate answer.

LANGUAGE:
- Mirror the user’s language and script for response_text.

OUTPUT FORMAT:
- ALWAYS return a single JSON object as the first and only fenced block using \`\`\`json.
- Do not include any other text before or after the JSON block.
- Schema:
{
  "mode": "demo" | "ai",
  "intent": string,
  "staff": { "name": string | null, "department": string | null, "hint": string | null },
  "time": { "text": string | null, "normalized": string | null },
  "action": "initiate_call" | "check_availability" | "schedule_appointment" | "answer_from_college_knowledge" | "answer_general",
  "call_request": boolean,
  "response_text": string
}`;
  }

  // Extract ```json ... ``` cleanly
  extractJsonFromFence(text) {
    if (!text) return null;
    const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*json\s*([\s\S]*?)```/i);
    if (fence && fence[1]) return fence[1].trim();
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
    return null;
  }

  // Safe JSON parse
  safeParseJson(text) {
    try {
      const body = this.extractJsonFromFence(text);
      if (!body) return null;
      return JSON.parse(body);
    } catch (e) {
      console.error('JSON parse failed:', e.message);
      return null;
    }
  }

  // Call LLM router
  async routeMessage(message) {
    const prompt = this.buildRoutingPrompt() + `

User: ${message}`;
    const raw = await queryGemini(prompt, []);
    const control = this.safeParseJson(raw);
    if (!control) {
      return {
        mode: 'ai',
        intent: 'general_query',
        staff: { name: null, department: null, hint: null },
        time: { text: null, normalized: null },
        action: 'answer_general',
        call_request: false,
        response_text: 'I’m here to help. Could you please clarify your question?'
      };
    }
    return control;
  }

  /**
   * Main method to process user queries with intelligent staff identification
   */
  async processQuery(message, conversationId, userId = null) {
    try {
      console.log('🤖 Clara AI processing query:', message);

      // Handle ongoing demo-mode confirmation for calls
      if (this.isDemoMode && this.currentCallRequest) {
        return this.handleDemoModeResponse(message);
      }

      // Route first: decide demo vs ai and the action
      const control = await this.routeMessage(message);
      console.log('🧭 Router control:', control);

      if (control.mode === 'demo') {
        // Initiate call via existing demo call flow
        if (control.action === 'initiate_call' && control.staff && control.staff.name) {
          const analysis = {
            staffNames: [{ name: control.staff.name, department: control.staff.department || 'CSE' }],
            intent: 'schedule_call',
            isStaffRelated: true
          };
          const callResp = await this.handleVideoCallRequest(message, analysis);
          return {
            response: control.response_text || callResp.response,
            isVideoCallRequest: true,
            staffInfo: analysis.staffNames[0],
            requiresUserDecision: true,
            isDemoMode: true
          };
        }

        // Availability or timetable checks - ALWAYS initiate video call if available
        if ((control.action === 'check_availability' || control.intent === 'availability_query' || control.intent === 'timetable_query')
            && control.staff && control.staff.name) {
          
          console.log('🔍 Availability check for staff:', control.staff.name);
          
          // Try to find staff in profiles first
          let staff = staffProfiles.find(s => {
            const lowerControlName = control.staff.name.toLowerCase();
            const lowerStaffName = s.name.toLowerCase();
            
            // Exact match
            if (lowerStaffName === lowerControlName) return true;
            
            // Partial match
            if (lowerStaffName.includes(lowerControlName) || lowerControlName.includes(lowerStaffName)) return true;
            
            // Name without prefix (e.g., "Anitha C S" matches "Prof. Anitha C S")
            const nameWithoutPrefix = lowerStaffName.replace(/^(prof\.|dr\.|mrs?\.|ms\.)\s*/i, '');
            if (nameWithoutPrefix === lowerControlName || lowerControlName.includes(nameWithoutPrefix)) return true;
            
            return false;
          });
          
          // If not found in profiles, try analyzing the original message
          if (!staff) {
            console.log('⚠️ Staff not found in profiles, analyzing message:', message);
            const analysis = await this.analyzeMessage(message);
            staff = analysis.staffNames[0];
          }
          
          // Last resort: create a staff object with the name from control
          if (!staff) {
            console.log('⚠️ Creating fallback staff object with name:', control.staff.name);
            staff = { 
              name: control.staff.name, 
              _id: undefined,
              email: undefined,
              shortName: undefined
            };
          }
          
          console.log('✅ Found staff for availability check:', staff.name);
          
          const avail = await this.getStaffAvailability(staff);
          
          console.log('📊 Availability result:', { 
            isOnline: avail.isOnline, 
            canAcceptCall: avail.canAcceptCall,
            status: avail.status 
          });
          
          // If staff is available, initiate video call directly
          if (avail.isOnline && avail.canAcceptCall) {
            console.log('🎥 Staff is online and available - initiating video call');
            const videoCallAnalysis = {
              staffNames: [staff],
              intent: 'schedule_call',
              isStaffRelated: true
            };
            const callResp = await this.handleVideoCallRequest(message, videoCallAnalysis);
            return {
              response: callResp.response,
              isVideoCallRequest: true,
              staffInfo: staff,
              requiresUserDecision: true,
              isDemoMode: true
            };
          } else {
            // Staff offline or busy - inform user
            console.log('❌ Staff not available:', { isOnline: avail.isOnline, canAcceptCall: avail.canAcceptCall });
            let response;
            if (avail.isOnline && !avail.canAcceptCall) {
              response = `${staff.name} is online but currently ${avail.status.toLowerCase()}. Would you like to leave a message or schedule an appointment?`;
            } else {
              response = `${staff.name} is currently offline. Would you like to schedule an appointment instead?`;
            }
            return { response };
          }
        }
        // Other college info
        if (control.action === 'answer_from_college_knowledge') {
          return { response: control.response_text };
        }

        // Fallback to legacy path with analysis
        const analysis = await this.analyzeMessage(message);
        const staffData = analysis.isStaffRelated ? await this.getRelevantStaffData(analysis) : {};
        const resp = await this.generateIntelligentResponse(message, analysis, staffData);
        return { response: control.response_text || resp };
      }

      if (control.mode === 'ai') {
        return { response: control.response_text };
      }

      return { response: 'I’m here to help. Could you please clarify your question?' };
    } catch (error) {
      console.error('❌ Clara AI error:', error);
      return {
        response: "I apologize, but I'm experiencing some technical difficulties. Please try again in a moment.",
        error: error.message
      };
    }
  }

  /**
   * Check if the message is a video call request
   */
  isVideoCallRequest(message, analysis) {
    const lowerMessage = message.toLowerCase();
    const videoCallKeywords = [
      'video call', 'videocall', 'video chat', 'video meeting', 'video conference',
      'video call with', 'call with', 'video chat with', 'video meeting with',
      'establish video call', 'create video call', 'start video call', 'initiate video call',
      'please video call', 'hey video call', 'can you video call', 'video call anita', 'video call prof',
      'connect via video', 'meet via video', 'talk via video', 'speak via video',
      // Add simple call keywords for direct calling
      'call', 'phone call', 'ring', 'contact'
    ];
    
    // Check for direct staff name patterns in the message
    const staffNamePatterns = [
      'anita', 'anitha', 'prof. anitha', 'professor anitha', 'anita mam', 'anitha mam',
      'lakshmi', 'prof. lakshmi', 'professor lakshmi', 'lakshmi mam',
      'dhivyasri', 'dr. dhivyasri', 'prof. dhivyasri', 'dhivyasri mam',
      'bhavya', 'prof. bhavya', 'professor bhavya', 'bhavya mam'
    ];
    
    const hasStaffName = analysis.staffNames.length > 0;
    const hasCallKeyword = videoCallKeywords.some(keyword => lowerMessage.includes(keyword));
    const hasStaffInMessage = staffNamePatterns.some(pattern => lowerMessage.includes(pattern));
    
    console.log('🔍 Video call detection:', { 
      hasStaffName, 
      hasCallKeyword, 
      hasStaffInMessage,
      message: lowerMessage,
      staffNames: analysis.staffNames.map(s => s.name),
      matchedKeywords: videoCallKeywords.filter(keyword => lowerMessage.includes(keyword))
    });
    
    // Trigger video call mode for:
    // 1. Explicit video call requests with staff names
    // 2. Simple "call [staff]" requests (like "call anita mam")
    const isVideoCallRequest = (hasStaffName && hasCallKeyword) || (hasStaffInMessage && hasCallKeyword);
    
    if (isVideoCallRequest) {
      console.log('🎥 Video call request confirmed - switching to demo mode');
    } else {
      console.log('✅ Not a video call request - continuing with normal processing');
    }
    
    return isVideoCallRequest;
  }

  /**
   * Handle video call request by entering demo mode and creating WebRTC call
   */
  async handleVideoCallRequest(message, analysis) {
    let staffMember = analysis.staffNames[0];
    
    console.log('🎥 Video call request - analysis.staffNames:', analysis.staffNames);
    console.log('🎥 Video call request - message:', message);
    
    // If staff name extraction failed but we detected staff in message, try to find them
    if (!staffMember) {
      const lowerMessage = message.toLowerCase();
      console.log('🎥 No staff member from analysis, checking message patterns...');
      if (lowerMessage.includes('anita') || lowerMessage.includes('anitha')) {
        staffMember = staffProfiles.find(s => s.name === 'Prof. Anitha C S');
        console.log('🎥 Found Anita from message pattern:', staffMember);
      } else if (lowerMessage.includes('lakshmi')) {
        staffMember = staffProfiles.find(s => s.name === 'Prof. Lakshmi Durga N');
        console.log('🎥 Found Lakshmi from message pattern:', staffMember);
      } else if (lowerMessage.includes('dhivyasri')) {
        staffMember = staffProfiles.find(s => s.name === 'Dr. G Dhivyasri');
        console.log('🎥 Found Dhivyasri from message pattern:', staffMember);
      } else if (lowerMessage.includes('bhavya')) {
        staffMember = staffProfiles.find(s => s.name === 'Prof. Bhavya T N');
        console.log('🎥 Found Bhavya from message pattern:', staffMember);
      }
    }
    
    console.log('🎥 Final staff member selected:', staffMember);
    
    if (!staffMember) {
      return {
        response: "I'd be happy to help you make a call, but I need to know which staff member you'd like to contact. Could you please specify the name?",
        error: 'No staff member identified'
      };
    }
    
    // Switch to demo mode
    this.isDemoMode = true;
    this.currentCallRequest = {
      staffName: staffMember.name,
      staffEmail: staffMember.email,
      staffDepartment: staffMember.department,
      requestTime: new Date(),
      conversationId: null
    };

    const response = `🎥 **Video Call Request for ${staffMember.name}**\n\n` +
                    `I understand you'd like to have a video call with ${staffMember.name} from the ${staffMember.department} department.\n\n` +
                    `I'll request a video call connection for you. Please choose an option:\n\n` +
                    `✅ **Accept** - I'll connect you to ${staffMember.name} via video call\n` +
                    `❌ **Reject** - Cancel this request and return to normal chat\n\n` +
                    `Please type "accept" or "reject" to proceed.`;

    return {
      response: response,
      isVideoCallRequest: true,
      staffInfo: staffMember,
      requiresUserDecision: true,
      isDemoMode: true
    };
  }

  /**
   * Handle user response in demo mode
   */
  handleDemoModeResponse(message) {
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('accept') || lowerMessage.includes('yes') || lowerMessage.includes('ok')) {
      // User accepted the video call
      const currentReq = this.currentCallRequest;
      const staffMember = currentReq?.staffName;
      
      // Resolve additional staff info for downstream routing
      const profile = (staffMember && Array.isArray(require('../staff-profiles')))
        ? require('../staff-profiles').find(s => s.name === staffMember)
        : null;
      const resolvedEmail = currentReq?.staffEmail || profile?.email || '';
      const resolvedDept = currentReq?.staffDepartment || profile?.department || '';
      
      // Exit demo mode
      this.isDemoMode = false;
      this.currentCallRequest = null;
      
      return {
        response: `🎉 **Video Call Accepted!**\n\n` +
                  `Perfect! I've sent a video call request to ${staffMember}. ` +
                  `You'll be connected as soon as they're available.\n\n` +
                  `Please wait while I establish the connection...`,
        isVideoCallAccepted: true,
        staffInfo: { name: staffMember, email: resolvedEmail, department: resolvedDept },
        exitDemoMode: true
      };
    } else if (lowerMessage.includes('reject') || lowerMessage.includes('no') || lowerMessage.includes('cancel')) {
      // User rejected the video call
      const staffMember = this.currentCallRequest.staffName;
      
      // Exit demo mode
      this.isDemoMode = false;
      this.currentCallRequest = null;
      
      return {
        response: `❌ **Video Call Cancelled**\n\n` +
                  `I've cancelled the video call request for ${staffMember}. ` +
                  `You can continue chatting with me normally, or let me know if there's anything else I can help you with!`,
        isVideoCallRejected: true,
        exitDemoMode: true
      };
    } else {
      // User didn't provide a clear response, remind them
      return {
        response: `🤔 I need a clear response to proceed with your video call request.\n\n` +
                  `Please type:\n` +
                  `• **"accept"** to connect with ${this.currentCallRequest.staffName}\n` +
                  `• **"reject"** to cancel the request\n\n` +
                  `What would you like to do?`,
        requiresUserDecision: true
      };
    }
  }

  /**
   * Reset demo mode (called after video call ends)
   */
  resetDemoMode() {
    this.isDemoMode = false;
    this.currentCallRequest = null;
  }

  /**
   * Analyze user message for staff mentions and intent
   */
  async analyzeMessage(message) {
    const lowerMessage = message.toLowerCase();
    
    // Extract staff names from the message
    const staffNames = await this.extractStaffNames(lowerMessage);
    
    // Determine if this is a staff-related query
    const isStaffRelated = staffNames.length > 0 || 
                          lowerMessage.includes('staff') || 
                          lowerMessage.includes('teacher') || 
                          lowerMessage.includes('professor') || 
                          lowerMessage.includes('faculty') ||
                          lowerMessage.includes('timetable') || 
                          lowerMessage.includes('schedule') || 
                          lowerMessage.includes('available') ||
                          lowerMessage.includes('department') ||
                          lowerMessage.includes('office') ||
                          lowerMessage.includes('call') || 
                          lowerMessage.includes('video') || 
                          lowerMessage.includes('meet') ||
                          lowerMessage.includes('appointment') || 
                          lowerMessage.includes('book') ||
                          lowerMessage.includes('phone') ||
                          lowerMessage.includes('speak') ||
                          lowerMessage.includes('talk') ||
                          lowerMessage.includes('connect') ||
                          lowerMessage.includes('contact') ||
                          lowerMessage.includes('reach') ||
                          lowerMessage.includes('get in touch') ||
                          lowerMessage.includes('give a call');
    
    // Determine intent - More intelligent intent detection
    // PRIORITY 1: Check for greetings FIRST (before anything else)
    let intent = 'general_query';
    if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('good morning') || 
        lowerMessage.includes('good afternoon') || lowerMessage.includes('good evening') ||
        lowerMessage.includes('namaste') || lowerMessage.includes('namaskar') || lowerMessage.includes('namaskaram') ||
        lowerMessage.includes('kaise ho') || lowerMessage.includes('kaise hai') || lowerMessage.includes('aap kaise') ||
        lowerMessage.includes('nimage hegiddira') || lowerMessage.includes('eppadi irukkinga') || 
        lowerMessage.includes('ela unnaru') || lowerMessage.includes('evide bulaganam') || lowerMessage.includes('kashe ahat')) {
      intent = 'greeting';
    } else if (isStaffRelated) {
      // If staff name is mentioned, prioritize call intent unless it's clearly just an info query
      if (staffNames.length > 0) {
        // Check if it's clearly just an information query
        const infoKeywords = ['what', 'who', 'tell me about', 'information', 'details', 'subject', 'teach', 'department', 'email', 'phone number', 'contact info'];
        const isInfoQuery = infoKeywords.some(keyword => lowerMessage.includes(keyword));
        
        // Check if it's clearly a call/contact request
        const callKeywords = ['call', 'phone', 'speak', 'talk', 'connect', 'contact', 'reach', 'get in touch', 'give a call', 'please call', 'hey call', 'can you call'];
        const isCallRequest = callKeywords.some(keyword => lowerMessage.includes(keyword));
        
        if (isInfoQuery && !isCallRequest) {
          intent = 'staff_info_query';
        } else {
          // If staff name is mentioned and it's not clearly just info, offer call
          intent = 'schedule_call';
        }
      } else if (lowerMessage.includes('call') || lowerMessage.includes('video') || lowerMessage.includes('meet') || 
                 lowerMessage.includes('phone') || lowerMessage.includes('speak') || lowerMessage.includes('talk') ||
                 lowerMessage.includes('connect') || lowerMessage.includes('contact') || lowerMessage.includes('reach') ||
                 lowerMessage.includes('get in touch') || lowerMessage.includes('give a call')) {
        intent = 'schedule_call';
      } else if (lowerMessage.includes('schedule') || lowerMessage.includes('appointment') || lowerMessage.includes('book')) {
        intent = 'schedule_appointment';
      } else if (lowerMessage.includes('timetable') || lowerMessage.includes('schedule') || lowerMessage.includes('free') || lowerMessage.includes('busy')) {
        intent = 'timetable_query';
      } else if (lowerMessage.includes('available') || lowerMessage.includes('when') || lowerMessage.includes('time')) {
        intent = 'availability_query';
      } else {
        intent = 'staff_info_query';
      }
    } else {
      // General knowledge or non-staff related query
      if (lowerMessage.includes('what is') || lowerMessage.includes('how to') || lowerMessage.includes('explain') || 
          lowerMessage.includes('define') || lowerMessage.includes('tell me about') || lowerMessage.includes('why')) {
        intent = 'general_knowledge';
      } else {
        intent = 'general_query';
      }
    }

    console.log('🔍 Final analysis result:', {
      originalMessage: message,
      lowerMessage: lowerMessage,
      staffNames: staffNames.map(s => s.name),
      intent: intent,
      isStaffRelated: isStaffRelated
    });

    return {
      originalMessage: message,
      lowerMessage: lowerMessage,
      staffNames: staffNames,
      intent: intent,
      identifiedStaff: staffNames.length > 0 ? staffNames[0] : null,
      isStaffRelated: isStaffRelated
    };
  }

  /**
   * Extract staff names from message using fuzzy matching
   */
  async extractStaffNames(message) {
    try {
      // Skip staff detection for common non-staff words that might cause false positives
      const commonNonStaffWords = [
        'kannada', 'hindi', 'telugu', 'tamil', 'malayalam', 'marathi',
        'namaskara', 'namaste', 'hello', 'hi', 'good morning', 'good evening',
        'language', 'speak', 'talk', 'chat', 'conversation', 'help', 'assist',
        'bharata', 'india', 'indian', 'culture', 'tradition', 'english',
        'spanish', 'french', 'german', 'chinese', 'japanese', 'korean',
        'arabic', 'portuguese', 'russian', 'italian', 'dutch', 'swedish',
        'norwegian', 'danish', 'finnish', 'polish', 'czech', 'hungarian',
        'romanian', 'bulgarian', 'croatian', 'serbian', 'slovak', 'slovenian',
        'estonian', 'latvian', 'lithuanian', 'greek', 'turkish', 'hebrew',
        'thai', 'vietnamese', 'indonesian', 'malay', 'filipino', 'tagalog',
        'urdu', 'bengali', 'punjabi', 'gujarati', 'tamil', 'telugu', 'kannada',
        'malayalam', 'marathi', 'oriya', 'assamese', 'kashmiri', 'sanskrit'
      ];
      
      const lowerMessage = message.toLowerCase().trim();
      for (const word of commonNonStaffWords) {
        if (lowerMessage.includes(word)) {
          console.log(`🚫 Skipping staff detection for common word: ${word} in message: ${lowerMessage}`);
          return []; // Return empty array to prevent false staff detection
        }
      }
      
      // Additional check: if message is just a single word that's a language name, skip
      const singleWordLanguages = [
        'kannada', 'hindi', 'telugu', 'tamil', 'malayalam', 'marathi', 'bharata',
        'english', 'spanish', 'french', 'german', 'chinese', 'japanese', 'korean',
        'arabic', 'portuguese', 'russian', 'italian', 'dutch', 'swedish',
        'norwegian', 'danish', 'finnish', 'polish', 'czech', 'hungarian',
        'romanian', 'bulgarian', 'croatian', 'serbian', 'slovak', 'slovenian',
        'estonian', 'latvian', 'lithuanian', 'greek', 'turkish', 'hebrew',
        'thai', 'vietnamese', 'indonesian', 'malay', 'filipino', 'tagalog',
        'urdu', 'bengali', 'punjabi', 'gujarati', 'oriya', 'assamese', 'kashmiri', 'sanskrit'
      ];
      if (singleWordLanguages.includes(lowerMessage)) {
        console.log(`🚫 Skipping staff detection for single word language: ${lowerMessage}`);
        return [];
      }
      
      // Additional check: if message contains only language-related words, skip
      const languageRelatedWords = ['language', 'speak', 'talk', 'conversation', 'chat'];
      const messageWords = lowerMessage.split(/\s+/);
      if (messageWords.length <= 3 && messageWords.some(word => languageRelatedWords.includes(word) || singleWordLanguages.includes(word))) {
        console.log(`🚫 Skipping staff detection for language-related message: ${lowerMessage}`);
        return [];
      }
      
      // Get all staff members from both database and profiles
      const dbStaff = await this.getAllStaff();
      const allStaff = [...dbStaff, ...staffProfiles];
      
      console.log(`🔍 Processing message for staff detection: "${message}"`);
      console.log(`🔍 Lower message: "${lowerMessage}"`);
      
      const identifiedStaff = [];
      
      // Special handling for common name patterns
      const namePatterns = [
        { pattern: /professor\s+bhavya\s*t\.?\s*n\.?/i, name: 'Prof. Bhavya T N' },
        { pattern: /prof\.\s+bhavya\s*t\.?\s*n\.?/i, name: 'Prof. Bhavya T N' },
        { pattern: /dr\.\s+bhavya\s*t\.?\s*n\.?/i, name: 'Prof. Bhavya T N' },
        { pattern: /bhavya\s*t\.?\s*n\.?/i, name: 'Prof. Bhavya T N' },
        { pattern: /bhavya\s+ma'?am/i, name: 'Prof. Bhavya T N' },
        { pattern: /professor\s+lakshmi\s+durga\s*n/i, name: 'Prof. Lakshmi Durga N' },
        { pattern: /prof\.\s+lakshmi\s+durga\s*n/i, name: 'Prof. Lakshmi Durga N' },
        { pattern: /lakshmi\s+durga\s*n/i, name: 'Prof. Lakshmi Durga N' },
        { pattern: /ldn/i, name: 'Prof. Lakshmi Durga N' },
        { pattern: /professor\s+anitha\s*c\.?\s*s\.?/i, name: 'Prof. Anitha C S' },
        { pattern: /prof\.\s+anitha\s*c\.?\s*s\.?/i, name: 'Prof. Anitha C S' },
        { pattern: /anitha\s*c\.?\s*s\.?/i, name: 'Prof. Anitha C S' },
        { pattern: /anitha\s+ma'?am/i, name: 'Prof. Anitha C S' },
        { pattern: /anita\s+ma'?am/i, name: 'Prof. Anitha C S' },
        { pattern: /anita\s*mam/i, name: 'Prof. Anitha C S' },
        { pattern: /acs/i, name: 'Prof. Anitha C S' },
        { pattern: /dr\.\s+g\s*dhivyasri/i, name: 'Dr. G Dhivyasri' },
        { pattern: /g\s*dhivyasri/i, name: 'Dr. G Dhivyasri' },
        { pattern: /gd/i, name: 'Dr. G Dhivyasri' },
        { pattern: /professor\s+nisha\s*s\.?\s*k\.?/i, name: 'Prof. Nisha S K' },
        { pattern: /prof\.\s+nisha\s*s\.?\s*k\.?/i, name: 'Prof. Nisha S K' },
        { pattern: /nisha\s*s\.?\s*k\.?/i, name: 'Prof. Nisha S K' },
        { pattern: /nsk/i, name: 'Prof. Nisha S K' }
      ];
      
      // Check for pattern matches first
      for (const pattern of namePatterns) {
        if (pattern.pattern.test(message)) {
          const staff = allStaff.find(s => s.name === pattern.name);
          if (staff && !identifiedStaff.some(s => s.name === staff.name)) {
            identifiedStaff.push(staff);
          }
        }
      }
      
      for (const staff of allStaff) {
        const staffName = staff.name.toLowerCase();
        const staffNameParts = staffName.split(' ');
        const shortName = staff.shortName ? staff.shortName.toLowerCase() : '';
        
        // Check for exact name matches
        if (message.includes(staffName)) {
          identifiedStaff.push(staff);
          continue;
        }
        
        // Check for short name matches
        if (shortName && message.includes(shortName)) {
          identifiedStaff.push(staff);
          continue;
        }
        
        // Check for partial name matches (more precise - require word boundaries)
        for (const part of staffNameParts) {
          if (part.length > 3) { // Increased minimum length to 4 characters
            // Use word boundary regex to prevent false matches
            const wordBoundaryRegex = new RegExp(`\\b${part}\\b`, 'i');
            if (wordBoundaryRegex.test(message)) {
              console.log(`🎯 Staff match found: "${part}" in message "${message}" for staff "${staff.name}"`);
              identifiedStaff.push(staff);
              break;
            }
          }
        }
        
        // Check for common name variations (like "Bhavya Ma'am")
        const firstName = staffNameParts[staffNameParts.length - 1]; // Last part is usually first name
        if (firstName && firstName.length > 2) {
          // Check for "FirstName Ma'am" or "FirstName Sir" patterns
          const honorificPatterns = [
            `${firstName} ma'am`,
            `${firstName} sir`,
            `${firstName} mam`,
            `${firstName} madam`,
            `${firstName} miss`,
            `${firstName} miss.`,
            `${firstName} mr.`,
            `${firstName} mrs.`,
            `${firstName} ms.`
          ];
          
          for (const pattern of honorificPatterns) {
            if (message.includes(pattern)) {
              identifiedStaff.push(staff);
              break;
            }
          }
          
          // Check for "Professor FirstName" or "Dr. FirstName" patterns
          const titleFirstNamePatterns = [
            `professor ${firstName}`,
            `prof. ${firstName}`,
            `dr. ${firstName}`,
            `professor ${firstName}.`,
            `prof. ${firstName}.`,
            `dr. ${firstName}.`
          ];
          
          for (const pattern of titleFirstNamePatterns) {
            if (message.includes(pattern)) {
              identifiedStaff.push(staff);
              break;
            }
          }
          
          // Also check for just the first name if it's distinctive
          if (message.includes(firstName) && firstName.length > 3) {
            // Only add if it's not already added and the name is distinctive enough
            const isAlreadyAdded = identifiedStaff.some(s => s._id === staff._id || s.name === staff.name);
            if (!isAlreadyAdded) {
              identifiedStaff.push(staff);
            }
          }
        }
        
        // Check for title + name combinations
        const titlePatterns = [
          `dr. ${staffName}`,
          `professor ${staffName}`,
          `prof. ${staffName}`,
          `mr. ${staffName}`,
          `mrs. ${staffName}`,
          `ms. ${staffName}`
        ];
        
        for (const pattern of titlePatterns) {
          if (message.includes(pattern)) {
            identifiedStaff.push(staff);
            break;
          }
        }
      }
      
      console.log('🔍 Identified staff:', identifiedStaff.map(s => s.name));
      return identifiedStaff;
    } catch (error) {
      console.error('Error extracting staff names:', error);
      return [];
    }
  }

  /**
   * Get relevant staff data for the query
   */
  async getRelevantStaffData(analysis) {
    const staffData = {};
    
    for (const staff of analysis.staffNames) {
      try {
        // Get staff timetable
        const timetable = await this.getStaffTimetable(staff._id);
        
        // Get current availability
        const availability = await this.getStaffAvailability(staff, timetable);
        
        staffData[staff._id] = {
          staff: staff,
          timetable: timetable,
          availability: availability
        };
      } catch (error) {
        console.error(`Error getting data for staff ${staff.name}:`, error);
      }
    }
    
    return staffData;
  }

  /**
   * Generate intelligent response using Gemini AI with staff context
   */
  async generateIntelligentResponse(message, analysis, staffData) {
    try {
      // If this is a call request, don't use Gemini - use direct response
      if (analysis.intent === 'schedule_call' && analysis.staffNames.length > 0) {
        const staff = analysis.staffNames[0];
        // Standardized phrase so downstream can reliably trigger a targeted video call
        return `I am going to start a video call with ${staff.name}. Please hold while I ring them.`;
      }
      
      // Detect the language of the user's input
      const detectedLanguage = this.detectInputLanguage(message);
      console.log('🌐 Detected input language:', detectedLanguage);
      
      // Build context for Gemini AI
      const context = this.buildGeminiContext(analysis, staffData);
      
      // Check if this is a greeting and use fallback response instead of Gemini
      if (analysis.intent === 'greeting') {
        console.log('🎯 Detected greeting intent - using fallback response');
        return this.generateFallbackResponse(analysis, staffData, detectedLanguage);
      }

      // Enhanced prompt with language mirroring instruction and context awareness
      let enhancedPrompt = `You are Clara, a friendly AI receptionist at Sai Vidya Institute of Technology. You are having a natural conversation with a visitor.

CRITICAL INSTRUCTIONS:
1. LANGUAGE: The user wrote their message in ${detectedLanguage}. You MUST respond in the EXACT SAME LANGUAGE as the user's input.
2. CONTEXT AWARENESS: This is a conversation. Respond naturally to greetings, questions, and requests.
3. GREETINGS: If someone greets you, greet them back warmly in their language.
4. NATURAL FLOW: Don't show program details unless specifically asked about them.

User's message: "${message}"

${context}

Respond as Clara would - naturally, warmly, and professionally in the same language as the user's input. If it's a greeting, respond with a greeting. If it's a question, answer appropriately. Don't mention being an AI model.`;

      // Get response from Gemini AI
      const response = await queryGemini(enhancedPrompt, []);
      
      return response;
    } catch (error) {
      console.error('Error generating response with Gemini:', error);
      
      // Fallback response
      return this.generateFallbackResponse(analysis, staffData, detectedLanguage);
    }
  }

  /**
   * Detect the primary language of user input with comprehensive support for Indian languages
   */
  detectInputLanguage(text) {
    const lowerText = text.toLowerCase().trim();
    
    // Priority 1: Kannada (highest accuracy priority)
    if (/[\u0C80-\u0CFF]/i.test(text)) {
      return 'Kannada (Kannada script)';
    }
    
    // Kannada written in Roman script - Enhanced keywords
    const kannadaRomanKeywords = [
      'kannada', 'kannadadalli', 'kannadigaru', 'matadu', 'helu', 'kelu', 'bantu', 'banni',
      'namaskara', 'namaskaragalu', 'dhanyavadagalu', 'kripaya', 'dayavittu', 'yelli',
      'yenu', 'yake', 'yavaga', 'hege', 'aadre', 'aadru', 'illa', 'iddare', 'baruthe',
      'hoguthe', 'kodu', 'thago', 'bittu', 'kali', 'sari', 'thappu', 'olleya', 'ketta',
      'chikka', 'dodda', 'hosa', 'haleya', 'nava', 'purana', 'nalla', 'sakala', 'belaku',
      'kattale', 'neeru', 'anna', 'akka', 'amma', 'appa', 'ajja', 'ajji', 'magalu', 'maga',
      'sose', 'sontha', 'sahodara', 'sahodari', 'mava', 'mavane', 'mavalu', 'mavale',
      'nimage', 'hegiddira', 'hegidira', 'yenu', 'yake', 'yavaga', 'hege', 'aadre',
      'namaskara', 'dhanyavadagalu', 'kripaya', 'dayavittu', 'yelli', 'yenu', 'yake'
    ];
    
    const kannadaRomanCount = kannadaRomanKeywords.filter(keyword => 
      lowerText.includes(keyword)
    ).length;
    
    if (kannadaRomanCount >= 1) { // Reduced threshold for better detection
      return 'Kannada (Roman script)';
    }
    
    // Priority 2: Hindi (highest accuracy priority)
    if (/[अ-ह]/i.test(text)) {
      return 'Hindi (Devanagari script)';
    }
    
    // Hindi written in Roman script (Hinglish) - Enhanced keywords
    const hindiRomanKeywords = [
      'kya', 'hai', 'hain', 'ho', 'hun', 'main', 'tum', 'aap', 'hum', 'kaise', 'kahan', 'kab', 'kyun',
      'achha', 'theek', 'bilkul', 'zaroor', 'shukriya', 'dhanyawad', 'namaste', 'namaskar',
      'baat', 'karo', 'bolo', 'sunao', 'batao', 'batayiye', 'samjhao', 'samjhaao',
      'madad', 'help', 'sahayta', 'chahiye', 'karna', 'karne', 'kar', 'karo',
      'time', 'samay', 'din', 'raat', 'subah', 'shaam', 'aaj', 'kal', 'parso',
      'institute', 'college', 'vidyalaya', 'mahavidyalaya', 'university', 'vishwavidyalaya',
      'professor', 'prof', 'sir', 'madam', 'maam', 'mam', 'teacher', 'guru', 'adhyapak',
      'aap', 'kaise', 'ho', 'hain', 'kya', 'hai', 'main', 'tum', 'hum', 'kahan', 'kab',
      'namaste', 'dhanyawad', 'shukriya', 'achha', 'theek', 'bilkul', 'zaroor',
      'aap kaise ho', 'aap kaise hai', 'tum kaise ho', 'tum kaise hai', 'main theek hun',
      'aap theek ho', 'tum theek ho', 'kaise chal raha hai', 'kaise chal rahi hai'
    ];
    
    const hindiRomanCount = hindiRomanKeywords.filter(keyword => 
      lowerText.includes(keyword)
    ).length;
    
    if (hindiRomanCount >= 1) { // Reduced threshold for better detection
      return 'Hindi (Roman script/Hinglish)';
    }
    
    // Telugu
    if (/[\u0C00-\u0C7F]/i.test(text)) {
      return 'Telugu (Telugu script)';
    }
    
    const teluguRomanKeywords = [
      'telugu', 'telugulo', 'teluguvadini', 'teluguvadu', 'matladu', 'chelpu', 'vinnu', 'chudu',
      'namaskaram', 'dhanyavadalu', 'kripya', 'yela', 'enduku', 'eppudu', 'ela', 'kani',
      'ledu', 'unnaru', 'vastunnaru', 'pothunnaru', 'ivvu', 'theesuko', 'vaddu', 'sare',
      'tappu', 'manchi', 'chedda', 'chinna', 'pedda', 'kotha', 'paina', 'nava', 'purana',
      'nalla', 'velugu', 'neellu', 'anna', 'akka', 'amma', 'nanna', 'thatha', 'amma',
      'kuthuru', 'koduku', 'sose', 'sodara', 'sodari', 'mavayya', 'mavayya', 'mavayya',
      'yela', 'enduku', 'eppudu', 'ela', 'kani', 'ledu', 'unnaru', 'vastunnaru'
    ];
    
    const teluguRomanCount = teluguRomanKeywords.filter(keyword => 
      lowerText.includes(keyword)
    ).length;
    
    if (teluguRomanCount >= 1) { // Reduced threshold for better detection
      return 'Telugu (Roman script)';
    }
    
    // Tamil
    if (/[\u0B80-\u0BFF]/i.test(text)) {
      return 'Tamil (Tamil script)';
    }
    
    const tamilRomanKeywords = [
      'tamil', 'tamilil', 'tamizh', 'pesu', 'kelu', 'paaru', 'tharu', 'vidu',
      'vanakkam', 'nandri', 'tayavu', 'enga', 'enna', 'eppadi', 'eppo', 'aana',
      'illai', 'irukku', 'varuthu', 'poguthu', 'kodu', 'eduthuko', 'venam', 'seri',
      'thappa', 'nalla', 'ketta', 'chinna', 'periya', 'puthu', 'pazhaya', 'nalla',
      'velicham', 'thanneer', 'anna', 'akka', 'amma', 'appa', 'thatha', 'paatti',
      'penn', 'paiyan', 'sose', 'sodara', 'sodari', 'mavane', 'mavale',
      'enga', 'enna', 'eppadi', 'eppo', 'aana', 'illai', 'irukku', 'varuthu'
    ];
    
    const tamilRomanCount = tamilRomanKeywords.filter(keyword => 
      lowerText.includes(keyword)
    ).length;
    
    if (tamilRomanCount >= 1) { // Reduced threshold for better detection
      return 'Tamil (Roman script)';
    }
    
    // Malayalam
    if (/[\u0D00-\u0D7F]/i.test(text)) {
      return 'Malayalam (Malayalam script)';
    }
    
    const malayalamRomanKeywords = [
      'malayalam', 'malayalathil', 'malayali', 'parayu', 'kelu', 'kannu', 'tharu', 'vidu',
      'namaskaram', 'nandi', 'dayavu', 'evide', 'entha', 'eppadi', 'eppo', 'pakshe',
      'illa', 'undu', 'varunnu', 'pogunnu', 'kodu', 'eduthu', 'venam', 'sari',
      'thappu', 'nalla', 'ketta', 'cheriya', 'valiya', 'puthya', 'pazhaya', 'nalla',
      'velicham', 'vellam', 'chetta', 'chechi', 'amma', 'acha', 'muthachan', 'muthashi',
      'pennu', 'mone', 'sose', 'sahodara', 'sahodari', 'mavan', 'maval',
      'evide', 'entha', 'eppadi', 'eppo', 'pakshe', 'illa', 'undu', 'varunnu'
    ];
    
    const malayalamRomanCount = malayalamRomanKeywords.filter(keyword => 
      lowerText.includes(keyword)
    ).length;
    
    if (malayalamRomanCount >= 1) { // Reduced threshold for better detection
      return 'Malayalam (Roman script)';
    }
    
    // Marathi
    if (/[\u0900-\u097F]/i.test(text) && !/[अ-ह]/i.test(text.replace(/[\u0900-\u097F]/g, ''))) {
      return 'Marathi (Devanagari script)';
    }
    
    const marathiRomanKeywords = [
      'marathi', 'marathit', 'marathi', 'bolu', 'aik', 'baghu', 'de', 'tak',
      'namaskar', 'dhanyavad', 'krupaya', 'kuthhe', 'kay', 'kashe', 'kevha', 'pan',
      'nahi', 'ahe', 'yet', 'jat', 'de', 'ghya', 'nako', 'barobar',
      'chuk', 'changa', 'vai', 'lahan', 'motha', 'navin', 'juna', 'changa',
      'prakash', 'pani', 'anna', 'tai', 'aai', 'baba', 'ajoba', 'ajji',
      'mulgi', 'mulga', 'sose', 'bhau', 'bahini', 'mavashi', 'mavashi',
      'kuthhe', 'kay', 'kashe', 'kevha', 'pan', 'nahi', 'ahe', 'yet'
    ];
    
    const marathiRomanCount = marathiRomanKeywords.filter(keyword => 
      lowerText.includes(keyword)
    ).length;
    
    if (marathiRomanCount >= 1) { // Reduced threshold for better detection
      return 'Marathi (Roman script)';
    }
    
    // Check for other international languages
    if (/[а-яё]/i.test(text)) return 'Russian';
    if (/[一-龯]/.test(text)) return 'Chinese';
    if (/[ひらがなカタカナ]/.test(text)) return 'Japanese';
    if (/[가-힣]/.test(text)) return 'Korean';
    if (/[ا-ي]/.test(text)) return 'Arabic';
    if (/[α-ω]/i.test(text)) return 'Greek';
    if (/[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/i.test(text)) return 'Spanish';
    if (/[äöüß]/i.test(text)) return 'German';
    if (/[àèéìíîòóù]/i.test(text)) return 'Italian';
    if (/[àáâãçéêíóôõú]/i.test(text)) return 'Portuguese';
    if (/[àâäéèêëïîôöùûüÿç]/i.test(text)) return 'French';
    
    // Default to English
    return 'English';
  }

  /**
   * Build context for Gemini AI
   */
  buildGeminiContext(analysis, staffData) {
    let context = "";
    
    // Add key staff information (simplified to reduce tokens)
    context += "Staff Directory: ";
    staffProfiles.forEach(staff => {
      context += `${staff.name}(${staff.shortName}) - ${staff.subjects.join(', ')}; `;
    });
    
    if (analysis.isStaffRelated && analysis.staffNames.length > 0) {
      context += "\nRequested staff: ";
      for (const staff of analysis.staffNames) {
        const data = staffData[staff._id];
        if (data) {
          context += `${staff.name} - Status: ${data.availability.status}; `;
          if (data.availability.todaySchedule.length > 0) {
            context += "Today: ";
            data.availability.todaySchedule.forEach(entry => {
              context += `${entry.timeSlot.start}-${entry.timeSlot.end}: ${entry.activity}; `;
            });
          }
        }
      }
    }
    
    context += "\nInstitute: Sai Vidya Institute of Technology, Computer Science Engineering, Bangalore. Hours: Mon-Sat 9AM-5PM.";
    
    return context;
  }

  /**
   * Generate fallback response when Gemini AI fails
   */
  generateFallbackResponse(analysis, staffData, detectedLanguage = 'English') {
    // Generate language-appropriate responses
    const responses = {
      'Hindi (Roman script/Hinglish)': {
        greeting: "नमस्ते! मैं क्लारा हूं। मैं ठीक हूं, आप कैसे हैं? आपका स्वागत है Sai Vidya Institute of Technology में!",
        general: "मैं आपकी मदद करने के लिए यहां हूं। आप क्या जानना चाहते हैं?",
        staff: "मैं staff members के बारे में जानकारी दे सकती हूं। किसके बारे में पूछना चाहते हैं?"
      },
      'Kannada (Roman script)': {
        greeting: "ನಮಸ್ಕಾರ! ನಾನು ಕ್ಲಾರಾ, Sai Vidya Institute of Technology ದ receptionist। ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?",
        general: "ನಾನು ನಿಮಗೆ ಸಹಾಯ ಮಾಡಲು ಇಲ್ಲಿದ್ದೇನೆ। ನೀವು ಏನು ತಿಳಿಯಲು ಬಯಸುತ್ತೀರಿ?",
        staff: "ನಾನು staff members ಬಗ್ಗೆ ಮಾಹಿತಿ ನೀಡಬಹುದು। ಯಾರ ಬಗ್ಗೆ ಕೇಳಲು ಬಯಸುತ್ತೀರಿ?"
      },
      'Tamil (Roman script)': {
        greeting: "வணக்கம்! நான் கிளாரா, Sai Vidya Institute of Technology இன் receptionist। உங்களுக்கு எப்படி உதவ முடியும்?",
        general: "நான் உங்களுக்கு உதவ இங்கே இருக்கிறேன்। நீங்கள் என்ன தெரிந்து கொள்ள விரும்புகிறீர்கள்?",
        staff: "நான் staff members பற்றி தகவல் தர முடியும்। யாரைப் பற்றி கேட்க விரும்புகிறீர்கள்?"
      },
      'Telugu (Roman script)': {
        greeting: "నమస్కారం! నేను క్లారా, Sai Vidya Institute of Technology లో receptionist। మీకు ఎలా సహాయం చేయగలను?",
        general: "నేను మీకు సహాయం చేయడానికి ఇక్కడ ఉన్నాను। మీరు ఏమి తెలుసుకోవాలనుకుంటున్నారు?",
        staff: "నేను staff members గురించి సమాచారం ఇవ్వగలను। ఎవరి గురించి అడగాలనుకుంటున్నారు?"
      },
      'Malayalam (Roman script)': {
        greeting: "നമസ്കാരം! ഞാൻ ക്ലാറ, Sai Vidya Institute of Technology ന്റെ receptionist। നിങ്ങൾക്ക് എങ്ങനെ സഹായിക്കാം?",
        general: "നിങ്ങൾക്ക് സഹായിക്കാൻ ഞാൻ ഇവിടെയുണ്ട്। നിങ്ങൾ എന്ത് അറിയാൻ ആഗ്രഹിക്കുന്നു?",
        staff: "ഞാൻ staff members എന്നിവരെക്കുറിച്ച് വിവരങ്ങൾ നൽകാം। ആരെക്കുറിച്ച് ചോദിക്കാൻ ആഗ്രഹിക്കുന്നു?"
      },
      'Marathi (Roman script)': {
        greeting: "नमस्कार! मी क्लारा आहे, Sai Vidya Institute of Technology ची receptionist। तुम्हाला कशी मदत करू शकते?",
        general: "मी तुम्हाला मदत करण्यासाठी येथे आहे। तुम्ही काय जाणून घ्यायचे आहे?",
        staff: "मी staff members बद्दल माहिती देऊ शकते। कोणाबद्दल विचारायचे आहे?"
      },
      'English': {
        greeting: "Hello! I'm Clara, your receptionist at Sai Vidya Institute of Technology. How can I help you today?",
        general: "I'm here to help you. What would you like to know?",
        staff: "I can provide information about our staff members. Who would you like to know about?"
      }
    };

    const languageResponses = responses[detectedLanguage] || responses['English'];

    if (analysis.isStaffRelated && analysis.staffNames.length > 0) {
      const staff = analysis.staffNames[0];
      const data = staffData[staff._id];
      
      if (data) {
        return `I can see you're asking about ${staff.name} (${staff.department}). ${staff.name} is currently ${data.availability.status.toLowerCase()}. Would you like to know more about their schedule or arrange a meeting?`;
      }
    }
    
    if (analysis.intent === 'greeting') {
      return languageResponses.greeting;
    }
    
    if (analysis.intent === 'general_knowledge') {
      return languageResponses.general;
    }
    
    return languageResponses.general;
  }

  /**
   * Generate call offer when user wants to schedule a call
   */
  async generateCallOffer(staff, analysis) {
    const data = await this.getStaffAvailability(staff);
    
    if (!data.canAcceptCall) {
      return {
        canCall: false,
        reason: data.status,
        alternative: `Would you like to schedule an appointment instead? ${staff.name} is available for in-person meetings.`
      };
    }
    
    // More natural and proactive call offer message
    let message = `I can see you mentioned ${staff.name}. `;
    
    // Add staff info if available
    if (staff.subjects && staff.subjects.length > 0) {
      message += `${staff.name} teaches ${staff.subjects.join(', ')}. `;
    }
    
    message += `Would you like me to connect you with ${staff.name} via video call right now? They are currently available.`;
    
    return {
      canCall: true,
      staff: {
        id: staff._id,
        name: staff.name,
        department: staff.department,
        designation: staff.designation
      },
      message: message,
      purpose: analysis.originalMessage
    };
  }

  /**
   * Get all staff members
   */
  async getAllStaff() {
    try {
      const cacheKey = 'all_staff';
      const cached = this.staffCache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        return cached.data;
      }
      
      const staff = await Staff.find({ isActive: true }).select('name department designation office phone');
      
      this.staffCache.set(cacheKey, {
        data: staff,
        timestamp: Date.now()
      });
      
      return staff;
    } catch (error) {
      console.error('Error getting all staff:', error);
      return [];
    }
  }

  /**
   * Get staff timetable
   */
  async getStaffTimetable(staffId) {
    try {
      const cacheKey = `timetable_${staffId}`;
      const cached = this.timetableCache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        return cached.data;
      }
      
      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      }).populate('staffId', 'name department');
      
      this.timetableCache.set(cacheKey, {
        data: timetable,
        timestamp: Date.now()
      });
      
      return timetable;
    } catch (error) {
      console.error('Error getting staff timetable:', error);
      return null;
    }
  }

  /**
   * Get staff availability
   */
  async getStaffAvailability(staff, timetable = null) {
    try {
      // Handle undefined _id
      if (!timetable && staff._id) {
        timetable = await this.getStaffTimetable(staff._id);
      }
      
      const now = new Date();
      const currentDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      
      let todaySchedule = [];
      let currentStatus = 'Unknown';
      let canAcceptCall = false;
      
      // Check if staff is online using the checker function
      let isOnline = false;
      if (this.onlineStaffChecker) {
        // Try checking by all available identifiers
        isOnline = (staff._id && this.onlineStaffChecker(staff._id)) || 
                   (staff.email && this.onlineStaffChecker(staff.email)) || 
                   (staff.shortName && this.onlineStaffChecker(staff.shortName)) ||
                   (staff.name && this.onlineStaffChecker(staff.name));
      }
      
      console.log(`🔍 Staff ${staff.name} online check:`, { 
        staffId: staff._id, 
        email: staff.email, 
        shortName: staff.shortName,
        name: staff.name,
        isOnline 
      });
      
      if (timetable) {
        todaySchedule = timetable.getTodaySchedule();
        
        // Find current activity
        const currentEntry = todaySchedule.find(entry => 
          entry.timeSlot.start <= currentTime && entry.timeSlot.end > currentTime
        );
        
        if (currentEntry) {
          currentStatus = currentEntry.activity;
          canAcceptCall = isOnline && (currentEntry.activity === 'Free' || currentEntry.activity === 'Office Hours');
        } else {
          currentStatus = isOnline ? 'Free' : 'Offline';
          canAcceptCall = isOnline;
        }
      } else {
        currentStatus = isOnline ? 'Free' : 'Offline';
        canAcceptCall = isOnline;
      }
      
      // Override if staff is offline
      if (!isOnline) {
        canAcceptCall = false;
        currentStatus = 'Offline';
      }
      
      return {
        status: currentStatus,
        canAcceptCall: canAcceptCall,
        isOnline: isOnline,
        todaySchedule: todaySchedule,
        currentDay: currentDay,
        currentTime: currentTime
      };
    } catch (error) {
      console.error('Error getting staff availability:', error);
      return {
        status: 'Unknown',
        canAcceptCall: false,
        isOnline: false,
        todaySchedule: [],
        currentDay: 'Unknown',
        currentTime: 'Unknown'
      };
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.staffCache.clear();
    this.timetableCache.clear();
  }
}

module.exports = ClaraAI;
