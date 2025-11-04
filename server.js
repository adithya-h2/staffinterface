const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Global error handlers to surface crashes during development
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION - server will exit');
  console.error(err && err.stack ? err.stack : err);
  // give logs a moment then exit with non-zero
  try { setTimeout(() => process.exit(1), 250); } catch (_) { process.exit(1); }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION - server will exit');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  try { setTimeout(() => process.exit(1), 250); } catch (_) { process.exit(1); }
});

// Import models
const User = require('./models/User');
const Staff = require('./models/Staff');
const StaffTimetable = require('./models/StaffTimetable');
const Appointment = require('./models/Appointment');
const Conversation = require('./models/Conversation');
const Call = require('./models/Call');
const Session = require('./models/Session');
const StaffCallLog = require('./models/StaffCallLog');
const { getStaffCallLogModel } = require('./services/staffCollections');

// Import services
const ClaraAI = require('./services/claraAI');
const { splitByScript } = require('./services/langSplit');
const { routeVoice } = require('./services/voices');

// Import Edge TTS service
const { spawn, exec } = require('child_process');

// Import Gemini AI
const { queryGemini } = require('./geminiApi');

// Import College AI
const CollegeAI = require('./services/collegeAI');
const collegeRoutes = require('./routes/college');

// Import Timetable Query Handler
const TimetableQueryHandler = require('./services/timetableQueryHandler');

// Import n8n Integration
const n8nRoutes = require('./routes/n8n');
const N8nService = require('./services/n8nService');

// Import Timetable routes
const timetableRoutes = require('./routes/timetable');

// Import new routes
const callRoutes = require('./routes/calls');
const appointmentRoutes = require('./routes/appointments');
const sessionRoutes = require('./routes/sessions');
const staffPortalRoutes = require('./routes/staffPortal');

// Import staff profiles for demo/staff login support
const staffProfiles = require('./staff-profiles.js');

// Initialize College AI
const collegeAI = new CollegeAI();

// Initialize Timetable Query Handler
const timetableQueryHandler = new TimetableQueryHandler();

// Initialize n8n Service
const n8nService = new N8nService();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Static middleware - serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Helper to check DB connectivity
const isDbConnected = () => mongoose.connection.readyState === 1;

// Helper function to check teacher availability based on timetable
function checkTeacherAvailability(entries, requestedDay = null) {
  const now = new Date();
  const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' });
  const currentTime = now.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit' 
  });

  // Use requested day if provided, otherwise use current day
  const targetDay = requestedDay || currentDay;
  
  console.log('🕐 Availability check:', { 
    currentDay, 
    requestedDay, 
    targetDay, 
    currentTime 
  });

  // Convert current time to minutes for easier comparison
  const currentMinutes = timeToMinutes(currentTime);

  // Find entries for the target day
  const dayEntries = entries.filter(entry => entry.day === targetDay);
  
  console.log(`📅 ${targetDay}'s entries:`, dayEntries.length, 'entries for', targetDay);
  
  if (dayEntries.length === 0) {
    const dayMessage = requestedDay ? `on ${targetDay}` : 'today';
    return {
      isAvailable: true,
      message: `The teacher is free ${dayMessage} (no classes scheduled)`,
      currentTime: currentTime,
      nextClass: null,
      daySchedule: generateDaySchedule(dayEntries, targetDay)
    };
  }

  // Sort entries by start time
  dayEntries.sort((a, b) => timeToMinutes(a.timeSlot.start) - timeToMinutes(b.timeSlot.start));

  console.log('📋 Sorted entries:', dayEntries.map(e => `${e.timeSlot.start}-${e.timeSlot.end}: ${e.subject}`));

  // Generate day schedule
  const daySchedule = generateDaySchedule(dayEntries, targetDay);

  // If checking a specific day (not current day), return the full schedule
  if (requestedDay && requestedDay !== currentDay) {
    return {
      isAvailable: true, // For specific day queries, we show the schedule
      message: `📅 ${targetDay} Schedule:\n\n${daySchedule}`,
      currentTime: currentTime,
      nextClass: null,
      daySchedule: daySchedule
    };
  }

  // Check if currently in a class (only for current day)
  for (const entry of dayEntries) {
    const startMinutes = timeToMinutes(entry.timeSlot.start);
    const endMinutes = timeToMinutes(entry.timeSlot.end);
    
    console.log(`🔍 Checking entry: ${entry.subject} (${entry.timeSlot.start}-${entry.timeSlot.end}) vs current time ${currentTime} (${currentMinutes} minutes)`);
    
    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      console.log('❌ Teacher is currently in class');
      return {
        isAvailable: false,
        message: `The teacher is currently occupied (${entry.subject} - ${entry.timeSlot.start} to ${entry.timeSlot.end})`,
        currentTime: currentTime,
        nextClass: null
      };
    }
  }

  // Find next class
  const nextClass = dayEntries.find(entry => timeToMinutes(entry.timeSlot.start) > currentMinutes);
  
  if (nextClass) {
    console.log('✅ Teacher is free, next class:', nextClass.subject, 'at', nextClass.timeSlot.start);
    return {
      isAvailable: true,
      message: `The teacher is free now. Next class: ${nextClass.subject} at ${nextClass.timeSlot.start}\n\n📅 Today's Schedule:\n${daySchedule}`,
      currentTime: currentTime,
      nextClass: {
        subject: nextClass.subject,
        time: nextClass.timeSlot.start,
        batch: nextClass.batch || ''
      },
      daySchedule: daySchedule
    };
  } else {
    console.log('✅ Teacher is free for the rest of the day');
    return {
      isAvailable: true,
      message: `The teacher is free for the rest of the day\n\n📅 Today's Schedule:\n${daySchedule}`,
      currentTime: currentTime,
      nextClass: null,
      daySchedule: daySchedule
    };
  }
}

// Helper function to convert time string to minutes
function timeToMinutes(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return hours * 60 + minutes;
}

// Helper function to generate day schedule
function generateDaySchedule(entries, day) {
  const timeSlots = [
    { time: '8:30-9:25', label: '8:30-9:25' },
    { time: '9:25-10:20', label: '9:25-10:20' },
    { time: '10:20-10:40', label: '10:20-10:40', isBreak: true, breakType: 'Coffee Break' },
    { time: '10:40-11:35', label: '10:40-11:35' },
    { time: '11:35-12:30', label: '11:35-12:30' },
    { time: '12:30-13:15', label: '12:30-13:15', isBreak: true, breakType: 'Lunch Break' },
    { time: '13:15-14:10', label: '13:15-14:10' },
    { time: '14:10-15:05', label: '14:10-15:05' },
    { time: '15:05-16:10', label: '15:05-16:10' }
  ];

  // Create table header
  let table = '```\n';
  table += '┌─────────────────┬─────────────────────────────────────────────────────────┐\n';
  table += '│      TIME       │                    CLASS STATUS                         │\n';
  table += '├─────────────────┼─────────────────────────────────────────────────────────┤\n';
  
  timeSlots.forEach(slot => {
    const entry = entries.find(e => 
      `${e.timeSlot.start}-${e.timeSlot.end}` === slot.time
    );
    
    let status = '';
    let statusIcon = '';
    
    if (entry) {
      statusIcon = '[BUSY]';
      const batchInfo = entry.batch ? ` (${entry.batch})` : '';
      const roomInfo = entry.room ? ` - ${entry.room}` : '';
      status = `${entry.subject}${batchInfo}${roomInfo}`;
    } else if (slot.isBreak) {
      statusIcon = '[BREAK]';
      status = `${slot.breakType}`;
    } else {
      statusIcon = '[FREE]';
      status = 'FREE';
    }
    
    // Format time column (15 chars)
    const timeCol = slot.label.padEnd(15);
    
    // Format status column (55 chars max) - align text properly
    const statusText = `${statusIcon} ${status}`;
    const statusCol = statusText.substring(0, 55).padEnd(55);
    
    table += `│ ${timeCol} │ ${statusCol} │\n`;
  });
  
  table += '└─────────────────┴─────────────────────────────────────────────────────────┘\n';
  table += '```';
  
  return table;
}

// Helper function to detect college-related queries
const isCollegeQuery = (message) => {
  const collegeKeywords = [
    // Academic terms
    'admission', 'apply', 'enroll', 'join', 'fee', 'cost', 'price', 'tuition', 'scholarship',
    'department', 'course', 'branch', 'cse', 'mechanical', 'civil', 'ece', 'ise', 'it', 'cs',
    'placement', 'job', 'career', 'salary',
    'event', 'fest', 'seminar', 'workshop', 'contact', 'phone', 'email', 'address',
    'sai vidya', 'engineering', 'college', 'university', 'institute', 'technology',
    // Academic queries
    'curriculum', 'syllabus', 'subjects', 'books', 'library', 'lab', 'laboratory',
    'exam', 'examination', 'test', 'result', 'grade', 'marks', 'cgpa', 'gpa',
    'hostel', 'accommodation', 'canteen', 'cafeteria', 'transport', 'bus',
    // Information queries (only if NOT calling/meeting staff)
    'facilities', 'campus', 'infrastructure', 'location', 'directions', 'map'
  ];
  
  const lowerMessage = message.toLowerCase();
  console.log('🔍 College query check for message:', message);
  console.log('🔍 Lowercase message:', lowerMessage);
  
  // Check for greeting patterns first - if it's a greeting, don't treat as college query
  const greetingPatterns = [
    'namaste', 'namaskar', 'hello', 'hi', 'good morning', 'good afternoon', 'good evening',
    'kaise ho', 'kaise hai', 'aap kaise', 'how are you', 'how do you do', 'hey clara',
    'clara hai', 'hai kya'
  ];
  
  const isGreeting = greetingPatterns.some(pattern => lowerMessage.includes(pattern));
  if (isGreeting) {
    console.log('✅ Detected as greeting, not college query');
    return false;
  }
  
  // Check for staff-calling keywords - these should go to Clara AI, not College AI
  const staffCallKeywords = [
    'call', 'meet', 'meeting', 'talk', 'speak', 'connect', 'video call', 'appointment',
    'set a meeting', 'schedule meeting', 'available', 'free', 'busy', 'timetable', 'schedule'
  ];
  
  // Dynamically get all staff names from staff-profiles.js
  const staffNameVariations = [];
  staffProfiles.forEach(staff => {
    // Add full name (lowercase)
    staffNameVariations.push(staff.name.toLowerCase());
    
    // Add first name only (e.g., "Anitha" from "Prof. Anitha C S")
    const firstName = staff.name.toLowerCase().replace(/^(prof\.|dr\.|mrs?\.|ms\.)\s*/i, '').split(/\s+/)[0];
    if (firstName) staffNameVariations.push(firstName);
    
    // Add short name (e.g., "ACS")
    if (staff.shortName) staffNameVariations.push(staff.shortName.toLowerCase());
    
    // Add email username (e.g., "anithacs" from "anithacs@gmail.com")
    if (staff.email) {
      const emailUsername = staff.email.split('@')[0].toLowerCase();
      staffNameVariations.push(emailUsername);
    }
  });
  
  const hasStaffName = staffNameVariations.some(name => lowerMessage.includes(name));
  const hasCallKeyword = staffCallKeywords.some(keyword => lowerMessage.includes(keyword));
  
  if (hasStaffName && hasCallKeyword) {
    console.log('✅ Detected staff call request, routing to Clara AI not College AI');
    console.log('📞 Matched staff name variation:', staffNameVariations.find(name => lowerMessage.includes(name)));
    return false; // Route to Clara AI for handling
  }
  
  // Check for very short messages that are likely not college queries
  if (lowerMessage.length < 3 || lowerMessage === 'yes' || lowerMessage === 'no') {
    console.log('✅ Short message, not college query');
    return false;
  }
  
  const isCollege = collegeKeywords.some(keyword => lowerMessage.includes(keyword));
  console.log('🔍 Is college query:', isCollege);
  return isCollege;
};

// Helper function to detect timetable-related queries
const isTimetableQuery = (message) => {
  const timetableKeywords = [
    'schedule', 'timetable', 'class', 'free', 'available', 'busy', 'teaching',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
    'room', 'lab', 'office hours', 'when does', 'what classes',
    'mr.', 'mrs.', 'ms.', 'dr.', 'prof.'
  ];
  
  const lowerMessage = message.toLowerCase();
  return timetableKeywords.some(keyword => lowerMessage.includes(keyword));
};

// Security middleware
// Relax CSP for inline scripts used by the static HTML pages
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API Routes - Define these BEFORE static middleware
app.post('/api/staff/call-request', async (req, res) => {
  try {
    const { staffId, clientName, purpose, clientSocketId } = req.body;
    
    console.log('📞 Direct call request received:', { staffId, clientName, purpose });
    
    // Find staff member
    const staffProfile = staffProfiles.find(s => s.shortName === staffId);
    if (!staffProfile) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    
    // Check if staff is online
    const staffSocketId = staffSessions.get(staffId);
    
    if (staffSocketId) {
      // Staff is online - send immediate notification
      const callRequest = {
        callId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        clientName,
        purpose: purpose || 'General inquiry',
        timestamp: new Date(),
        type: 'video-call'
      };
      
      io.to(staffSocketId).emit('incoming-call-request', callRequest);
      
      console.log(`✅ Call request sent to online staff: ${staffProfile.name}`);
      res.json({ 
        success: true, 
        message: `Call request sent to ${staffProfile.name}`,
        callId: callRequest.callId
      });
    } else {
      // Staff is offline - queue the request
      if (!pendingStaffCalls.has(staffId)) {
        pendingStaffCalls.set(staffId, []);
      }
      
      const queuedCall = {
        callId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        clientName,
        purpose: purpose || 'General inquiry',
        timestamp: new Date(),
        type: 'video-call'
      };
      
      pendingStaffCalls.get(staffId).push(queuedCall);
      
      console.log(`⏳ Call request queued for offline staff: ${staffProfile.name}`);
      res.json({ 
        success: true, 
        message: `Call request queued for ${staffProfile.name}. They will be notified when they come online.`,
        callId: queuedCall.callId
      });
    }
  } catch (error) {
    console.error('❌ Error processing call request:', error);
    res.status(500).json({ error: 'Failed to process call request' });
  }
});

app.get('/api/staff/status/:staffId', (req, res) => {
  const { staffId } = req.params;
  const isOnline = staffSessions.has(staffId);

  // Try resolve email from static profiles for lastSeen lookup
  const profile = staffProfiles.find(s => s.shortName === staffId);
  const staffEmail = profile?.email;
  const nowStr = new Date().toISOString();

  // Determine busy via activeCalls
  let isBusy = false;
  const staffSocketId = staffEmail ? staffEmailSessions.get(staffEmail) : null;
  if (staffSocketId) {
    for (const [, session] of activeCalls.entries()) {
      if (session.staffSocketId === staffSocketId) { isBusy = true; break; }
    }
  }

  // Attempt in-class via timetable if DB connected and we can resolve staff
  let inClass = false;
  (async () => {
    try {
      if (isDbConnected() && staffEmail) {
        const staffDoc = await Staff.findOne({ email: staffEmail });
        if (staffDoc) {
          const tt = await StaffTimetable.findOne({ staffId: staffDoc._id.toString(), isActive: true }).sort({ lastUpdated: -1 });
          if (tt?.entries?.length) {
            const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
            const avail = checkTeacherAvailability(tt.entries, null);
            if (avail && avail.isAvailable === false) inClass = true;
          }
        }
      }
    } catch (e) {
      // ignore enrichment errors
    } finally {
      let status = 'offline';
      if (isOnline) status = 'online';
      if (inClass) status = 'in_class';
      if (isBusy) status = 'busy';

      res.json({
        staffId,
        staffEmail: staffEmail || null,
        status,
        isOnline,
        isBusy,
        inClass,
        currentTime: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        lastSeen: !isOnline && staffEmail ? (lastSeenByEmail.get(staffEmail) || null) : null,
        timestamp: nowStr
      });
    }
  })();
});

// Static middleware already configured above

// Prevent favicon 404 noise
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Rate limiting (relaxed for local development to avoid 429 during testing)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,          // allow many requests during local testing
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clara_db')
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  console.log('⚠️  Running in demo mode without database');
});

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'demo_secret');
    if (isDbConnected()) {
      const user = await User.findById(decoded.userId);
      if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      req.user = user;
    } else {
      // Demo mode: attach a minimal user
      req.user = { _id: decoded.userId, role: 'staff', name: 'Demo Staff' };
    }
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Clara character prompt
const CLARA_PROMPT = `You are Clara, a friendly and professional AI receptionist. Your personality is:

1. Be warm, welcoming, and genuinely helpful
2. Use friendly, conversational language (not overly formal)
3. Answer any question asked - be informative and helpful
4. Show genuine interest in helping visitors
5. Be empathetic and understanding
6. Have a cheerful and positive attitude
7. Adapt your responses to be more casual and friendly when appropriate
8. Don't be robotic - be human-like and engaging

Always respond as Clara, maintaining your friendly receptionist personality. Be helpful, answer questions naturally, and make visitors feel welcome.`;

/**
 * Generate chatbot response using Gemini AI only
 */
async function generateResponse(message, conversationId, responseLanguage = 'en') {
  try {
    // Get conversation history when DB is available
    let messages = [];
    if (isDbConnected()) {
      const conversation = await Conversation.findOne({ sessionId: conversationId });
      messages = conversation ? conversation.messages.slice(-10) : [];
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    // Use Gemini AI with language parameter
    if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here') {
      try {
        console.log(`🤖 Using Gemini AI for response generation in ${responseLanguage}...`);
        const response = await queryGemini(message, messages, responseLanguage);
        return response;
      } catch (geminiError) {
        console.error('❌ Gemini AI error:', geminiError.message);
        console.log('⚠️  Falling back to demo responses...');
      }
    }

    // Fallback to demo responses
    console.log('⚠️  Using demo mode responses (no valid Gemini API key configured)');
    const fallbackResponses = [
      "Hi there! I'm Clara, your friendly AI receptionist! How can I help you today? 😊",
      "Welcome! I'm so glad you're here. What can I do for you?",
      "Hey there! I'm Clara and I'm here to help. What's on your mind?",
      "Hello! I'm your AI receptionist Clara. I'd love to assist you with anything you need!",
      "Welcome! I'm Clara and I'm excited to help you today. What brings you here?"
    ];
    return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
  } catch (error) {
    console.error('❌ Error generating response:', error?.response?.data || error.message);
    return 'I apologize, but I\'m experiencing some technical difficulties. Please try again in a moment.';
  }
}

// Enhanced in-memory storage for WebRTC calls and staff management
const connectedUsers = new Map(); // socketId -> user
const waitingCalls = new Map(); // socketId -> call
const activeCalls = new Map(); // callId -> call session
// Track last seen timestamps for staff by email
const lastSeenByEmail = new Map(); // staffEmail -> ISO timestamp
// Map staff identifiers to socket ids. Keys can be DB _id or shortName (ACS, LDN, etc.)
const staffSessions = new Map(); // staffKey -> socketId
const videoCallRequests = new Map(); // requestId -> video call request
const pendingVideoCalls = new Map(); // staffId -> pending video call requests
const pendingStaffCalls = new Map(); // staffId -> pending start-conversation call requests

// New email-based session mapping system
const staffEmailSessions = new Map(); // staffEmail -> socketId
const clientStaffSessions = new Map(); // clientId -> staffEmail
const staffRooms = new Map(); // staffEmail -> Set of socketIds in room
const incomingCallRequests = new Map(); // requestId -> { clientSocketId, clientId, clientName, staffEmail, timestamp }

// Note: Removed hardcoded demo staff injection to ensure only real staff (from staff-profiles.js) appear

const clientSessions = new Map(); // socketId -> client session

// Initialize Clara AI
const claraAI = new ClaraAI();

// Set up online staff checker for Clara AI
claraAI.setOnlineStaffChecker((staffIdentifier) => {
  if (!staffIdentifier) return false;
  
  const identifier = String(staffIdentifier).toLowerCase();
  
  // Check by shortName, email, or ID directly
  if (staffSessions.has(staffIdentifier)) {
    return true;
  }
  if (staffEmailSessions.has(staffIdentifier)) {
    return true;
  }
  
  // Check if any staff with this identifier is in staffSessions
  for (const [key, socketId] of staffSessions.entries()) {
    if (key === staffIdentifier || String(key).toLowerCase() === identifier) {
      return true;
    }
  }
  
  // Check by name in staff profiles
  const matchingProfile = staffProfiles.find(s => {
    const lowerName = s.name.toLowerCase();
    const lowerIdentifier = identifier;
    
    // Exact match
    if (lowerName === lowerIdentifier) return true;
    
    // Name without prefix (e.g., "anitha c s" matches "Prof. Anitha C S")
    const nameWithoutPrefix = lowerName.replace(/^(prof\.|dr\.|mrs?\.|ms\.)\s*/i, '');
    if (nameWithoutPrefix === lowerIdentifier) return true;
    
    // Partial match
    if (lowerName.includes(lowerIdentifier) || lowerIdentifier.includes(lowerName)) return true;
    
    // Check if staff with this name/email/shortName is online
    if (s.email && staffEmailSessions.has(s.email)) return true;
    if (s.shortName && staffSessions.has(s.shortName)) return true;
    
    return false;
  });
  
  return !!matchingProfile;
});

// In-memory storage for demo mode
const demoUsers = new Map();
const demoConversations = new Map();
const demoCalls = new Map();

// QR Code generation utility
const generateQRCode = (data) => {
  // Simple QR code generation for demo purposes
  // In production, you'd use a proper QR code library
  return {
    data: data,
    timestamp: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
  };
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Enhanced staff login with session management
  socket.on('staff-login', async (data) => {
    try {
      const { email, password } = data;
      let user = null;

      // 1) Try DB user first (when DB is connected)
      if (isDbConnected()) {
        const dbUser = await User.findOne({ email, role: 'staff' });
        if (dbUser && await bcrypt.compare(password, dbUser.password)) {
          dbUser.isAvailable = true;
          dbUser.lastActive = new Date();
          await dbUser.save();
          user = dbUser;
        }
      }

      // 2) Fallback to staff-profiles.js (plain credentials)
      if (!user) {
        const profile = staffProfiles.find(s => s.email.toLowerCase() === String(email || '').toLowerCase());
        if (profile && profile.password === password) {
          user = {
            _id: profile.shortName,
            name: profile.name,
            role: 'staff',
            department: profile.department,
            isAvailable: true,
            lastActive: new Date(),
            email: profile.email
          };
        }
      }

      // 3) Final fallback to demo env credentials
      if (!user && !isDbConnected()) {
        const demoEmail = process.env.DEMO_STAFF_EMAIL || 'staff@demo.com';
        const demoPassword = process.env.DEMO_STAFF_PASSWORD || 'demo123';
        if (email === demoEmail && password === demoPassword) {
          user = {
            _id: `staff_${Date.now()}`,
            name: 'Demo Staff',
            role: 'staff',
            department: 'Support',
            isAvailable: true,
            lastActive: new Date(),
            email: demoEmail
          };
        }
      }

      // If still no user, fail the login
      if (!user) {
        socket.emit('login-error', { message: 'Invalid credentials' });
        return;
      }

      // Store user connection and staff session
      connectedUsers.set(socket.id, user);
      // Map by database id
      staffSessions.set(user._id.toString(), socket.id);
      // Also map by shortName (e.g., 'ACS') so UI using short codes can target correctly
      try {
        const profile = staffProfiles.find(p =>
          (p.email && user.email && p.email.toLowerCase() === String(user.email).toLowerCase()) ||
          (p.name && user.name && p.name.toLowerCase() === String(user.name).toLowerCase())
        );
        if (profile && profile.shortName) {
          staffSessions.set(String(profile.shortName), socket.id);
        }
      } catch (_) {}

      // New email-based registration system
      if (user.email) {
        staffEmailSessions.set(user.email, socket.id);
        socket.join(user.email); // Join staff to their email-based room
        
        // Initialize staff room if not exists
        if (!staffRooms.has(user.email)) {
          staffRooms.set(user.email, new Set());
        }
        staffRooms.get(user.email).add(socket.id);
        
        console.log(`📧 Staff registered with email: ${user.email}`);
        console.log(`📧 Current staff email sessions:`, Array.from(staffEmailSessions.keys()));

        // Broadcast staff online status
        io.emit('staff_status_update', {
          staffEmail: user.email,
          status: 'online',
          timestamp: new Date().toISOString()
        });
      }

      const token = jwt.sign(
        { userId: user._id },
        process.env.JWT_SECRET || 'demo_secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      );

      socket.emit('staff-login-success', { 
        staff: { id: user._id, name: user.name, department: user.department, email: user.email }
      });

      // Send user login activity to n8n webhook
      try {
        await n8nService.processUserActivity({
          userId: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          action: 'login'
        });
      } catch (n8nError) {
        console.error('❌ n8n user activity processing error:', n8nError.message);
        // Don't fail the main flow if n8n is down
      }
      
      // Notify about waiting calls
      if (isDbConnected()) {
        const waitingCallCount = await Call.countDocuments({ status: 'waiting' });
        socket.emit('waiting-calls', { count: waitingCallCount });
      } else {
        socket.emit('waiting-calls', { count: waitingCalls.size });
      }

      // Check for pending video call requests
      const pendingRequests = pendingVideoCalls.get(user._id.toString()) || [];
      if (pendingRequests.length > 0) {
        socket.emit('pending-video-calls', { requests: pendingRequests });
      }

      // Deliver any queued start-conversation calls for this staff (when they were offline)
      const queuedCalls = pendingStaffCalls.get(user._id.toString()) || [];
      if (queuedCalls.length > 0) {
        queuedCalls.forEach(c => {
          socket.emit('new-call-request', c);
        });
        pendingStaffCalls.set(user._id.toString(), []);
      }

      // Emit available staff list to all clients
      io.emit('staff-list-updated', { 
        staff: Array.from(staffSessions.keys()).map(staffId => {
          const staffUser = connectedUsers.get(staffSessions.get(staffId));
          return { id: staffId, name: staffUser.name, department: staffUser.department };
        })
      });
    } catch (error) {
      socket.emit('login-error', { message: 'Login failed' });
    }
  });

  // Handle session restoration (page refresh)
  socket.on('restore-session', async (data) => {
    try {
      const { staff } = data;
      if (!staff || !staff.email) {
        return;
      }

      console.log('🔄 Restoring session for:', staff.email);

      // Find staff profile
      const profile = staffProfiles.find(s => s.email.toLowerCase() === staff.email.toLowerCase());
      if (!profile) {
        return;
      }

      // Re-register staff in sessions
      const user = {
        _id: profile.shortName,
        name: profile.name,
        role: 'staff',
        department: profile.department,
        isAvailable: true,
        lastActive: new Date(),
        email: profile.email
      };

      connectedUsers.set(socket.id, user);
      staffSessions.set(user._id.toString(), socket.id);
      staffSessions.set(String(profile.shortName), socket.id);

      if (user.email) {
        staffEmailSessions.set(user.email, socket.id);
        socket.join(user.email);
        
        if (!staffRooms.has(user.email)) {
          staffRooms.set(user.email, new Set());
        }
        staffRooms.get(user.email).add(socket.id);
        
        console.log(`✅ Session restored for: ${user.email}`);

        // Broadcast staff online status on session restore
        io.emit('staff_status_update', {
          staffEmail: user.email,
          status: 'online',
          timestamp: new Date().toISOString()
        });
      }

      // Check for waiting calls
      if (isDbConnected()) {
        const waitingCallCount = await Call.countDocuments({ status: 'waiting' });
        socket.emit('waiting-calls', { count: waitingCallCount });
      } else {
        socket.emit('waiting-calls', { count: waitingCalls.size });
      }
    } catch (error) {
      console.error('Session restore error:', error);
    }
  });

  // Enhanced client conversation start with staff selection
  socket.on('start-conversation', async (data) => {
    try {
      const { name, email, purpose, selectedStaffId } = data;
      
      // Validate staff selection
      if (!selectedStaffId) {
        socket.emit('conversation-error', { message: 'Please select a staff member to connect with' });
        return;
      }

      // Resolve staff socket if online (may be undefined if offline)
      const staffSocketId = staffSessions.get(selectedStaffId);
      // Resolve staff profile from static list (supports offline flow)
      const staffProfile = staffProfiles.find(
        (s) => String(s.shortName).toLowerCase() === String(selectedStaffId).toLowerCase()
      );

      const staffUser = staffSocketId ? connectedUsers.get(staffSocketId) : null;
      
      // Check if MongoDB is connected
      if (mongoose.connection.readyState === 1) {
        // Use MongoDB
        let user = await User.findOne({ email });
        if (!user) {
          user = new User({
            name,
            email,
            password: await bcrypt.hash(Math.random().toString(), 10),
            role: 'client'
          });
          await user.save();
        }

        // Create conversation
        const sessionId = socket.id;
        const conversation = new Conversation({
          userId: user._id,
          sessionId,
          messages: [{
            sender: 'system',
            content: `New conversation started by ${name} with staff ${(staffUser?.name || staffProfile?.name || 'Staff')} - Initial context: ${purpose}`,
            messageType: 'system'
          }]
        });
        await conversation.save();

        // Resolve staff DB user id (selectedStaffId may be a socket/session id or shortName)
        let staffDbUserId = null;
        try {
          staffDbUserId = new mongoose.Types.ObjectId(selectedStaffId);
        } catch (_) {
          staffDbUserId = null;
        }

        if (!staffDbUserId) {
          // Try to find staff by email or name
          let staffDbUser = null;
          const candidateEmail = staffUser?.email || staffProfile?.email || `${selectedStaffId}@staff.local`;
          const candidateName = staffUser?.name || staffProfile?.name || `${selectedStaffId}`;

          if (candidateEmail) {
            staffDbUser = await User.findOne({ email: candidateEmail, role: 'staff' });
          }
          if (!staffDbUser && candidateName) {
            staffDbUser = await User.findOne({ name: candidateName, role: 'staff' });
          }
          if (!staffDbUser) {
            staffDbUser = new User({
              name: candidateName,
              email: candidateEmail,
              password: await bcrypt.hash(Math.random().toString(), 10),
              role: 'staff',
              department: staffUser?.department || staffProfile?.department || 'General',
              isAvailable: true
            });
            await staffDbUser.save();
          }
          staffDbUserId = staffDbUser._id;
        }

        // Create call request with staff assignment
        const call = new Call({
          clientId: user._id,
          staffId: staffDbUserId,
          purpose: purpose || "General conversation and assistance",
          status: 'waiting'
        });
        await call.save();

        // Send call data to n8n webhook
        try {
          await n8nService.processCall(call);
        } catch (n8nError) {
          console.error('❌ n8n call processing error:', n8nError.message);
          // Don't fail the main flow if n8n is down
        }

        waitingCalls.set(socket.id, call);
        connectedUsers.set(socket.id, user);
        clientSessions.set(user._id.toString(), socket.id);

        // Notify selected staff if online, else queue for when they log in
        if (staffSocketId) {
          io.to(staffSocketId).emit('new-call-request', {
            callId: call._id,
            clientName: name,
            purpose,
            timestamp: new Date()
          });
        } else {
          const k = staffDbUserId.toString();
          if (!pendingStaffCalls.has(k)) pendingStaffCalls.set(k, []);
          pendingStaffCalls.get(k).push({
            callId: call._id,
            clientName: name,
            purpose,
            timestamp: new Date()
          });
        }

        socket.emit('conversation-started', { 
          sessionId, 
          callId: call._id,
          name: name,
          purpose: purpose,
          staffName: (staffUser?.name || staffProfile?.name || 'Staff'),
          staffDepartment: (staffUser?.department || staffProfile?.department || 'General'),
          selectedStaffId: selectedStaffId
        });
      } else {
        // Use in-memory storage for demo mode
        const sessionId = socket.id;
        const userId = `demo_${Date.now()}`;
        
        // Create demo user
        const demoUser = {
          _id: userId,
          name,
          email,
          role: 'client'
        };
        demoUsers.set(userId, demoUser);
        
        // Create demo conversation
        const demoConversation = {
          sessionId,
          userId,
          messages: [{
            sender: 'system',
            content: `New conversation started by ${name} with staff ${(staffUser?.name || staffProfile?.name || 'Staff')} - Purpose: ${purpose}`,
            messageType: 'system'
          }]
        };
        demoConversations.set(sessionId, demoConversation);
        
        // Create demo call
        const demoCall = {
          _id: `call_${Date.now()}`,
          clientId: userId,
          staffId: selectedStaffId,
          purpose,
          status: 'waiting',
          createdAt: new Date()
        };
        
        // Send demo call data to n8n webhook
        try {
          await n8nService.processCall(demoCall);
        } catch (n8nError) {
          console.error('❌ n8n demo call processing error:', n8nError.message);
          // Don't fail the main flow if n8n is down
        }
        
        demoCalls.set(sessionId, demoCall);
        connectedUsers.set(socket.id, demoUser);
        clientSessions.set(userId, socket.id);
        
        // Notify selected staff about new call (or queue if offline)
        if (staffSocketId) {
          io.to(staffSocketId).emit('new-call-request', {
            callId: demoCall._id,
            clientName: name,
            purpose,
            timestamp: new Date()
          });
        } else {
          const k = selectedStaffId.toString();
          if (!pendingStaffCalls.has(k)) pendingStaffCalls.set(k, []);
          pendingStaffCalls.get(k).push({
            callId: demoCall._id,
            clientName: name,
            purpose,
            timestamp: new Date()
          });
        }

        socket.emit('conversation-started', { 
          sessionId, 
          callId: demoCall._id,
          name: name,
          purpose: purpose,
          staffName: (staffUser?.name || staffProfile?.name || 'Staff'),
          staffDepartment: (staffUser?.department || staffProfile?.department || 'General'),
          selectedStaffId: selectedStaffId
        });
      }
    } catch (error) {
      console.error('Error starting conversation:', error);
      socket.emit('conversation-error', { message: 'Failed to start conversation: ' + error.message });
    }
  });

  // Enhanced staff call acceptance
  socket.on('accept-call', async (data) => {
    try {
      const { callId } = data;
      const staffUser = connectedUsers.get(socket.id);
      
      if (!staffUser || staffUser.role !== 'staff') {
        socket.emit('call-error', { message: 'Unauthorized: Staff access required' });
        return;
      }

      let clientSocketId = null;
      let selectedCall = null;

      if (isDbConnected()) {
        const call = await Call.findById(callId);
        if (!call || call.status !== 'waiting') {
          socket.emit('call-error', { message: 'Call not found or already processed' });
          return;
        }

        // Verify staff is assigned to this call
        if (call.staffId.toString() !== staffUser._id.toString()) {
          socket.emit('call-error', { message: 'You are not assigned to this call' });
          return;
        }

        call.status = 'in-progress';
        call.startTime = new Date();
        await call.save();

        // Send call acceptance data to n8n webhook
        try {
          await n8nService.processCall(call);
        } catch (n8nError) {
          console.error('❌ n8n call acceptance processing error:', n8nError.message);
          // Don't fail the main flow if n8n is down
        }

        // Find client socket
        clientSocketId = clientSessions.get(call.clientId.toString());
        selectedCall = call;
      } else {
        // Demo mode
        const entry = Array.from(waitingCalls.entries()).find(([id, c]) => c._id === callId);
        if (!entry) {
          socket.emit('call-error', { message: 'Call not found' });
          return;
        }
        
        clientSocketId = entry[0];
        const call = entry[1];
        
        // Verify staff is assigned to this call
        if (call.staffId !== staffUser._id.toString()) {
          socket.emit('call-error', { message: 'You are not assigned to this call' });
          return;
        }
        
        call.status = 'in-progress';
        call.startTime = new Date();
        
        // Send demo call acceptance data to n8n webhook
        try {
          await n8nService.processCall(call);
        } catch (n8nError) {
          console.error('❌ n8n demo call acceptance processing error:', n8nError.message);
          // Don't fail the main flow if n8n is down
        }
        
        waitingCalls.set(clientSocketId, call);
        selectedCall = call;
      }

      if (clientSocketId) {
        // Move call to active calls
        activeCalls.set(callId, {
          callId,
          clientSocketId,
          staffSocketId: socket.id,
          startTime: new Date(),
          status: 'in-progress'
        });

        // Remove from waiting calls
        waitingCalls.delete(clientSocketId);

        // Notify client
        io.to(clientSocketId).emit('call-accepted', {
          staffName: staffUser.name,
          staffDepartment: staffUser.department,
          callId: callId
        });

        // Notify staff
        socket.emit('call-started', { 
          callId, 
          clientId: selectedCall.clientId,
          clientName: selectedCall.clientName || 'Client'
        });

        // Emit updated waiting calls count
        io.emit('waiting-calls-updated', { 
          count: waitingCalls.size 
        });
      }
    } catch (error) {
      console.error('Error accepting call:', error);
      socket.emit('call-error', { message: 'Failed to accept call: ' + error.message });
    }
  });

  // Enhanced WebRTC signaling with call session validation
  socket.on('offer', (data) => {
    const { target, offer, callId } = data;
    
    // Validate call session
    const callSession = activeCalls.get(callId);
    if (!callSession) {
      socket.emit('signaling-error', { message: 'Invalid call session' });
      return;
    }

    // Verify sender is part of the call
    if (socket.id !== callSession.clientSocketId && socket.id !== callSession.staffSocketId) {
      socket.emit('signaling-error', { message: 'Unauthorized signaling attempt' });
      return;
    }

    // Forward offer to the other participant
    const targetSocketId = socket.id === callSession.clientSocketId ? 
      callSession.staffSocketId : callSession.clientSocketId;
    
    io.to(targetSocketId).emit('offer', { 
      offer, 
      from: socket.id,
      callId 
    });
  });

  socket.on('answer', (data) => {
    const { target, answer, callId } = data;
    
    // Validate call session
    const callSession = activeCalls.get(callId);
    if (!callSession) {
      socket.emit('signaling-error', { message: 'Invalid call session' });
      return;
    }

    // Verify sender is part of the call
    if (socket.id !== callSession.clientSocketId && socket.id !== callSession.staffSocketId) {
      socket.emit('signaling-error', { message: 'Unauthorized signaling attempt' });
      return;
    }

    // Forward answer to the other participant
    const targetSocketId = socket.id === callSession.clientSocketId ? 
      callSession.staffSocketId : callSession.clientSocketId;
    
    io.to(targetSocketId).emit('answer', { 
      answer, 
      from: socket.id,
      callId 
    });
  });

  socket.on('ice-candidate', (data) => {
    const { target, candidate, callId } = data;
    
    // Validate call session
    const callSession = activeCalls.get(callId);
    if (!callSession) {
      socket.emit('signaling-error', { message: 'Invalid call session' });
      return;
    }

    // Verify sender is part of the call
    if (socket.id !== callSession.clientSocketId && socket.id !== callSession.staffSocketId) {
      socket.emit('signaling-error', { message: 'Unauthorized signaling attempt' });
      return;
    }

    // Forward ICE candidate to the other participant
    const targetSocketId = socket.id === callSession.clientSocketId ? 
      callSession.staffSocketId : callSession.clientSocketId;
    
    io.to(targetSocketId).emit('ice-candidate', { 
      candidate, 
      from: socket.id,
      callId 
    });
  });

  // Enhanced call end handling
  socket.on('end-call', async (data) => {
    try {
      const { callId, reason } = data;
      const user = connectedUsers.get(socket.id);
      
      if (!user) {
        socket.emit('call-error', { message: 'User not authenticated' });
        return;
      }

      const callSession = activeCalls.get(callId);
      if (!callSession) {
        socket.emit('call-error', { message: 'Call session not found' });
        return;
      }

      // Verify user is part of the call
      if (socket.id !== callSession.clientSocketId && socket.id !== callSession.staffSocketId) {
        socket.emit('call-error', { message: 'Unauthorized call end attempt' });
        return;
      }

      // Notify both participants
      const otherSocketId = socket.id === callSession.clientSocketId ? 
        callSession.staffSocketId : callSession.clientSocketId;
      
      io.to(otherSocketId).emit('call-ended', { 
        callId, 
        reason: reason || 'Call ended by other participant',
        endedBy: user.name
      });

      socket.emit('call-ended', { 
        callId, 
        reason: reason || 'Call ended',
        endedBy: user.name
      });

      // Generate QR code for the completed call
      const qrCodeData = {
        callId: callId,
        participants: {
          client: callSession.clientSocketId,
          staff: callSession.staffSocketId
        },
        duration: callSession.startTime ? Math.floor((new Date() - callSession.startTime) / 1000) : 0,
        endTime: new Date(),
        purpose: 'Video call completion'
      };

      const qrCode = generateQRCode(JSON.stringify(qrCodeData));

      // Send QR code to client interface
      io.to(callSession.clientSocketId).emit('call-completed-qr', {
        callId,
        qrCode,
        message: 'Call completed! Here is your QR code:'
      });

      // Reset Clara AI to full mode
      claraAI.resetDemoMode();

      // Notify client that Clara is back to full AI mode
      io.to(callSession.clientSocketId).emit('clara-ai-reset', {
        message: `🎉 Call completed! Clara is now back to full AI mode. You can ask me anything!`
      });

      // Persist staff call log
      try {
        if (isDbConnected()) {
          const staffInfo = connectedUsers.get(callSession.staffSocketId) || {};
          const clientInfo = connectedUsers.get(callSession.clientSocketId) || {};
          const staffEmail = staffInfo.email;
          const durationSec = qrCodeData.duration || 0;
          if (staffEmail) {
            // Write to global call log (legacy)
            await StaffCallLog.findOneAndUpdate(
              { callId, staffEmail },
              {
                $setOnInsert: {
                  type: 'incoming',
                  caller: clientInfo.name || 'Client',
                  callee: staffInfo.name || 'Staff',
                  timestamp: callSession.startTime || new Date(),
                  staffUsername: staffEmail.split('@')[0]
                },
                $set: {
                  status: 'completed',
                  duration: durationSec,
                  metadata: { reason: reason || 'ended' }
                }
              },
              { upsert: true, new: true }
            );

            // Also write to per-staff collection
            try {
              const username = (staffEmail.split('@')[0] || '').toLowerCase();
              const CL = getStaffCallLogModel(username);
              await CL.findOneAndUpdate(
                { callId, staffEmail },
                {
                  $setOnInsert: {
                    type: 'incoming',
                    caller: clientInfo.name || 'Client',
                    callee: staffInfo.name || 'Staff',
                    timestamp: callSession.startTime || new Date(),
                    staffUsername: username
                  },
                  $set: {
                    status: 'completed',
                    duration: durationSec,
                    metadata: { reason: reason || 'ended' }
                  }
                },
                { upsert: true, new: true }
              );
            } catch (_) {}
          }
        }
      } catch (logErr) {
        console.error('Failed to write StaffCallLog:', logErr.message);
      }

      // Clean up call session
      activeCalls.delete(callId);

      // Update call status in database if available
      if (isDbConnected()) {
        try {
          const call = await Call.findById(callId);
          if (call) {
            call.status = 'completed';
            call.endTime = new Date();
            call.duration = Math.floor((call.endTime - call.startTime) / 1000);
            await call.save();
          }
        } catch (dbError) {
          console.error('Error updating call status:', dbError);
        }
      }

    } catch (error) {
      console.error('Error ending call:', error);
      socket.emit('call-error', { message: 'Failed to end call: ' + error.message });
    }
  });

  // Call decision
  socket.on('call-decision', async (data) => {
    try {
      const { callId, decision, notes } = data;
      const staffUser = connectedUsers.get(socket.id);
      
      if (!staffUser || staffUser.role !== 'staff') {
        return;
      }
      if (isDbConnected()) {
        const call = await Call.findById(callId);
        if (!call || call.staffId.toString() !== staffUser._id.toString()) {
          return;
        }

        call.status = 'completed';
        call.endTime = new Date();
        call.decision = decision;
        call.notes = notes;
        call.duration = Math.floor((call.endTime - call.startTime) / 1000);
        await call.save();

        // Send call completion data to n8n webhook
        try {
          await n8nService.processCall(call);
        } catch (n8nError) {
          console.error('❌ n8n call completion processing error:', n8nError.message);
          // Don't fail the main flow if n8n is down
        }

        // Notify client
        const clientSocketId = Array.from(connectedUsers.entries())
          .find(([id, user]) => user._id.toString() === call.clientId.toString())?.[0];

        if (clientSocketId) {
          io.to(clientSocketId).emit('call-completed', { decision, notes });
        }

        socket.emit('decision-saved', { callId, decision });
      } else {
        // Demo mode: update in-memory call
        const clientSocketId = Array.from(waitingCalls.keys()).find(() => false); // no-op to satisfy linter; not used here
        // Just notify staff and client (if we can find by matching connectedUsers client)
        const demoClientEntry = Array.from(connectedUsers.entries()).find(([id, user]) => user.role === 'client');
        if (demoClientEntry) {
          io.to(demoClientEntry[0]).emit('call-completed', { decision, notes });
        }
        socket.emit('decision-saved', { callId, decision });
      }
    } catch (error) {
      socket.emit('error', { message: 'Failed to save decision' });
    }
  });

  // Handle video call request from Clara AI
  socket.on('video-call-request', async (data) => {
    try {
      let { staffId, staffName, staffEmail, staffDepartment, clientName, clientSocketId } = data;
      
      console.log('🎥 Video call request received:', { staffId, staffName, staffEmail, clientName });
      
      // Find staff member
      let staffSocketId = null;
      
      // Check in staff profiles first - more flexible matching
      const staffProfile = staffProfiles.find(s => {
        try {
          // Email match (most reliable)
          if (staffEmail && s.email && s.email.toLowerCase() === staffEmail.toLowerCase()) return true;
          
          // Exact name match
          if (staffName && s.name.toLowerCase() === staffName.toLowerCase()) return true;
          
          // Partial name match (e.g., "Nagashree" matches "Dr. Nagashree N")
          if (staffName && s.name.toLowerCase().includes(staffName.toLowerCase())) return true;
          
          // Short name match (e.g., "NN" matches "Dr. Nagashree N")
          if (staffName && s.shortName && s.shortName.toLowerCase() === staffName.toLowerCase()) return true;
          
          // ID match
          if (staffId && s.shortName && s.shortName === staffId) return true;
          
          return false;
        } catch (_) {
          return false;
        }
      });
      
      if (staffProfile) {
        staffId = staffProfile.shortName;
        staffName = staffProfile.name;
        staffEmail = staffProfile.email;
        staffDepartment = staffProfile.department;
        staffSocketId = staffSessions.get(staffId);
        console.log('✅ Staff found:', { staffId, staffName: staffProfile.name, email: staffEmail, isOnline: !!staffSocketId });
      } else {
        console.log('❌ Staff not found in profiles. Searching for:', { staffId, staffName, staffEmail });
        console.log('Available staff:', staffProfiles.map(s => ({ name: s.name, email: s.email, shortName: s.shortName })));
        socket.emit('video-call-error', { message: `Staff member "${staffName}" not found` });
        return;
      }
      
      if (!staffId) {
        socket.emit('video-call-error', { message: 'Staff member not found' });
        return;
      }
      
      // If staff is offline, queue the request for when they log in
      if (!staffSocketId) {
        // Create video call request
        const requestId = `vcr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const videoCallRequest = {
          requestId,
          staffId,
          staffName,
          staffDepartment,
          clientName,
          clientSocketId,
          status: 'pending',
          requestTime: new Date(),
          accepted: false
        };
        
        videoCallRequests.set(requestId, videoCallRequest);
        
        // Add to pending requests for the staff member
        if (!pendingVideoCalls.has(staffId)) {
          pendingVideoCalls.set(staffId, []);
        }
        pendingVideoCalls.get(staffId).push(videoCallRequest);
        
        // Notify client that request was queued
        socket.emit('video-call-request-sent', {
          requestId,
          staffName,
          message: `Video call request queued for ${staffName}. They will be notified when they come online.`
        });
        
        return;
      }
      
      // Staff is online, create and send request immediately
      const requestId = `vcr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const videoCallRequest = {
        requestId,
        staffId,
        staffName,
        staffDepartment,
        clientName,
        clientSocketId,
        status: 'pending',
        requestTime: new Date(),
        accepted: false
      };
      
      videoCallRequests.set(requestId, videoCallRequest);
      
      // Add to pending requests for the staff member
      if (!pendingVideoCalls.has(staffId)) {
        pendingVideoCalls.set(staffId, []);
      }
      pendingVideoCalls.get(staffId).push(videoCallRequest);
      
      // Notify staff member with ringing sound
      io.to(staffSocketId).emit('video-call-request', {
        ...videoCallRequest,
        ringSound: true,
        message: `🎥 Incoming video call request from ${clientName}`,
        callerName: clientName,
        purpose: 'Video call request'
      });
      
      // Notify client that request was sent
      socket.emit('video-call-request-sent', {
        requestId,
        staffName,
        message: `Video call request sent to ${staffName}. Waiting for response...`
      });
      
    } catch (error) {
      console.error('Error handling video call request:', error);
      socket.emit('video-call-error', { message: 'Failed to send video call request' });
    }
  });

  // Handle staff response to video call request
  socket.on('video-call-response', async (data) => {
    try {
      const { requestId, accepted, staffId } = data;
      
      const videoCallRequest = videoCallRequests.get(requestId);
      if (!videoCallRequest) {
        socket.emit('video-call-error', { message: 'Video call request not found' });
        return;
      }
      
      if (accepted) {
        // Staff accepted the call
        videoCallRequest.status = 'accepted';
        videoCallRequest.accepted = true;
        videoCallRequest.acceptedTime = new Date();
        
        // Notify client
        io.to(videoCallRequest.clientSocketId).emit('video-call-accepted', {
          requestId,
          staffName: videoCallRequest.staffName,
          message: `🎉 ${videoCallRequest.staffName} accepted your video call request!`
        });
        
        // Notify staff
        socket.emit('video-call-accepted-staff', {
          requestId,
          clientName: videoCallRequest.clientName,
          message: `Video call accepted with ${videoCallRequest.clientName}`
        });
        
        // Initialize WebRTC connection
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        activeCalls.set(callId, {
          callId,
          clientSocketId: videoCallRequest.clientSocketId,
          staffSocketId: socket.id,
          startTime: new Date(),
          status: 'connecting',
          videoCallRequest: requestId
        });
        
        // Emit call started events
        io.to(videoCallRequest.clientSocketId).emit('call-started', { callId });
        socket.emit('call-started', { callId });
        
      } else {
        // Staff rejected the call
        videoCallRequest.status = 'rejected';
        videoCallRequest.rejectedTime = new Date();
        
        // Notify client
        io.to(videoCallRequest.clientSocketId).emit('video-call-rejected', {
          requestId,
          staffName: videoCallRequest.staffName,
          message: `❌ ${videoCallRequest.staffName} is not available for video calls right now.`
        });
        
        // Reset Clara AI to full mode
        claraAI.resetDemoMode();
        
        // Notify client that Clara is back to full AI mode
        io.to(videoCallRequest.clientSocketId).emit('clara-ai-reset', {
          message: `Clara is now back to full AI mode. You can ask me anything!`
        });
      }
      
      // Remove from pending requests
      const pendingRequests = pendingVideoCalls.get(staffId) || [];
      const updatedRequests = pendingRequests.filter(req => req.requestId !== requestId);
      pendingVideoCalls.set(staffId, updatedRequests);
      
    } catch (error) {
      console.error('Error handling video call response:', error);
      socket.emit('video-call-error', { message: 'Failed to process video call response' });
    }
  });

  // Chat messages (allow chat without prior auth; create transient session if needed)
  socket.on('chat-message', async (data) => {
    try {
      const { sessionId, message, detectedLanguage } = data;
      console.log('📨 Chat message received:', { message, detectedLanguage });
      let user = connectedUsers.get(socket.id);
      
      if (!user) {
        const transientUser = { _id: `visitor_${socket.id}`, role: 'client', name: 'Visitor' };
        connectedUsers.set(socket.id, transientUser);
        user = transientUser;
      }

      // Save user message when DB is available
      let conversation = null;
      if (isDbConnected() && sessionId) {
        conversation = await Conversation.findOne({ sessionId });
        if (conversation) {
          conversation.messages.push({
            sender: 'user',
            content: message,
            messageType: 'text'
          });
          await conversation.save();
        }
      }

      // Generate AI response using appropriate AI service
      let aiResponse;
      let responseData = {};
      
      // Check if this is a timetable-related query
      if (isTimetableQuery(message)) {
        try {
          console.log('📅 Processing timetable query...');
          aiResponse = await timetableQueryHandler.processTimetableQuery(message);
        } catch (error) {
          console.error('Timetable query error, falling back to Gemini:', error);
          aiResponse = await generateResponse(message, sessionId, detectedLanguage);
        }
      }
      // Check if this is a college-related query
      else if (isCollegeQuery(message)) {
        console.log('🏫 College AI detected for message:', message);
        try {
          aiResponse = await collegeAI.processQuery(message, sessionId);
        } catch (error) {
          console.error('College AI error, falling back to Gemini:', error);
          aiResponse = await generateResponse(message, sessionId, detectedLanguage);
        }
      } else {
        // Use Clara AI for general queries
        console.log('🤖 Clara AI processing query:', message);
        const claraResponse = await claraAI.processQuery(message, sessionId, user._id);
        console.log('🤖 Clara AI response:', claraResponse);
        aiResponse = claraResponse.response;
        responseData = claraResponse;
      }
      
      // ENHANCED: If the response was generated in English but the user asked in an Indian language,
      // re-generate the response in the detected language
      if (detectedLanguage && detectedLanguage !== 'en' && !isTimetableQuery(message) && !isCollegeQuery(message)) {
        console.log(`🌐 Re-generating response in ${detectedLanguage}...`);
        try {
          const localizedResponse = await generateResponse(message, sessionId, detectedLanguage);
          if (localizedResponse) {
            aiResponse = localizedResponse;
          }
        } catch (error) {
          console.error('Error generating localized response:', error);
        }
      }
      
      // Save AI response
      if (conversation) {
        conversation.messages.push({
          sender: 'clara',
          content: aiResponse,
          messageType: 'text'
        });
        await conversation.save();
      }

      // Send conversation data to n8n webhook
      try {
        if (conversation) {
          await n8nService.processConversation({
            sessionId: conversation.sessionId,
            userId: conversation.userId,
            messages: conversation.messages
          });
        }
      } catch (n8nError) {
        console.error('❌ n8n conversation processing error:', n8nError.message);
        // Don't fail the main flow if n8n is down
      }

      // Send response with additional data
      socket.emit('ai-response', { 
        response: aiResponse,
        ...responseData
      });

      // Removed automatic video call request triggering
      // Video calls will only be initiated when user explicitly requests them

      // If this was a video call request that was accepted, initiate the call process
      if (responseData.isVideoCallAccepted && responseData.staffInfo) {
        console.log(`🎥 Video call accepted for staff:`, responseData.staffInfo);
        
        // Create WebRTC call and send to staff dashboard
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const clientName = user?.name || 'Client';
        
        // Create call session
        const callSession = {
          callId,
          clientId: user?._id || socket.id,
          clientName,
          staffEmail: responseData.staffInfo.email,
          staffName: responseData.staffInfo.name,
          status: 'initiating',
          startTime: new Date(),
          clientSocketId: socket.id
        };
        
        // Store call session
        activeCalls.set(callId, callSession);
        
        // Send call request to staff using new email-based system
        socket.emit('call-request', {
          clientId: callSession.clientId,
          staffEmail: responseData.staffInfo.email
        });
        
        // Send WebRTC call request to ALL staff members (broadcast)
        console.log(`📤 Broadcasting WebRTC call request to ALL staff members`);
        console.log(`📤 Call for: ${responseData.staffInfo.name} (${responseData.staffInfo.email})`);
        
        // Broadcast to all connected staff
        io.emit('webrtc-call-request', {
          callId,
          clientName,
          clientId: callSession.clientId,
          staffEmail: responseData.staffInfo.email,
          staffName: responseData.staffInfo.name,
          timestamp: new Date(),
          broadcast: true
        });
        
        // Also broadcast call update to all staff
        io.emit('call-update', {
          type: 'webrtc-call-request',
          callId,
          clientName,
          clientId: callSession.clientId,
          staffEmail: responseData.staffInfo.email,
          staffName: responseData.staffInfo.name,
          timestamp: new Date(),
          status: 'incoming',
          broadcast: true
        });
        
        console.log(`🎥 WebRTC call broadcasted to all staff: ${callId} for ${responseData.staffInfo.name}`);
      }

    } catch (error) {
      socket.emit('error', { message: 'Failed to process message' });
    }
  });

  // New call system events
  socket.on('call_initiated', (data) => {
    console.log('Call initiated:', data);
    // Broadcast to all staff members
    io.emit('call_initiated', data);
  });

  socket.on('call_accepted', (data) => {
    console.log('Call accepted:', data);
    // Broadcast to all clients
    io.emit('call_accepted', data);
  });

  socket.on('call_declined', (data) => {
    console.log('Call declined:', data);
    // Broadcast to all clients
    io.emit('call_declined', data);
  });

  socket.on('call_ended', (data) => {
    console.log('Call ended:', data);
    // Broadcast to all clients
    io.emit('call_ended', data);
  });

  // WebRTC signaling events
  // Allow peers to join a per-call room so signaling is scoped by callId
  socket.on('join_call', ({ callId }) => {
    try {
      if (!callId) return;
      console.log(`🔗 Socket ${socket.id} joining call room: ${callId}`);
      socket.join(callId);
    } catch (err) {
      console.error('Error joining call room:', err);
    }
  });

  socket.on('call_offer', (data) => {
    console.log('Call offer received:', data);
    // If a callId/sessionId is provided, forward only to that room; otherwise broadcast
    const targetRoom = data.sessionId || data.callId;
    if (targetRoom) {
      socket.to(targetRoom).emit('call_offer', data);
    } else {
      io.emit('call_offer', data);
    }
  });

  socket.on('call_answer', (data) => {
    console.log('Call answer received:', data);
    const targetRoom = data.sessionId || data.callId;
    if (targetRoom) {
      socket.to(targetRoom).emit('call_answer', data);
    } else {
      io.emit('call_answer', data);
    }
  });

  socket.on('ice_candidate', (data) => {
    console.log('ICE candidate received:', data);
    const targetRoom = data.sessionId || data.callId;
    if (targetRoom) {
      socket.to(targetRoom).emit('ice_candidate', data);
    } else {
      io.emit('ice_candidate', data);
    }
  });

  // Fallback: a peer can request the caller to (re)send an offer
  socket.on('request_offer', (data) => {
    try {
      const targetRoom = data?.sessionId || data?.callId;
      if (!targetRoom) return;
      console.log('🔄 request_offer for room:', targetRoom);
      socket.to(targetRoom).emit('request_offer', data);
    } catch (err) {
      console.error('Error relaying request_offer:', err);
    }
  });

  // Handle synchronized call ending
  socket.on('call-ended-by-client', ({ callId }) => {
    console.log(`📞 Call ended by client: ${callId}`);
    const callSession = activeCalls.get(callId);
    if (callSession) {
      // Notify staff that client ended the call
      io.to(callSession.staffSocketId).emit('call-ended-by-client', {
        callId,
        message: 'Client ended the call'
      });
      activeCalls.delete(callId);
    }
  });

  socket.on('call-ended-by-staff', ({ callId }) => {
    console.log(`📞 Call ended by staff: ${callId}`);
    const callSession = activeCalls.get(callId);
    if (callSession) {
      // Notify client that staff ended the call
      io.to(callSession.clientSocketId).emit('call-ended-by-staff', {
        callId,
        message: 'Staff ended the call'
      });
      activeCalls.delete(callId);
    }
  });


  // New email-based call request system
  socket.on('register-staff', (staffEmail) => {
    try {
      staffEmailSessions.set(staffEmail, socket.id);
      socket.join(staffEmail);
      
      // Initialize staff room if not exists
      if (!staffRooms.has(staffEmail)) {
        staffRooms.set(staffEmail, new Set());
      }
      staffRooms.get(staffEmail).add(socket.id);
      
      console.log(`📧 Staff registered with email: ${staffEmail}`);
      socket.emit('staff-registered', { email: staffEmail, success: true });
    } catch (error) {
      console.error('Error registering staff:', error);
      socket.emit('staff-registration-error', { message: 'Failed to register staff' });
    }
  });

  socket.on('connect-to-staff', ({ clientId, staffEmail }) => {
    try {
      clientStaffSessions.set(clientId, staffEmail);
      console.log(`🔗 Client ${clientId} connected to staff ${staffEmail}`);
      
      // Notify staff about new client
      io.to(staffEmail).emit('new-client', { clientId });
    } catch (error) {
      console.error('Error connecting client to staff:', error);
      socket.emit('connection-error', { message: 'Failed to connect to staff' });
    }
  });

  socket.on('send-message', ({ clientId, message }) => {
    try {
      const staffEmail = clientStaffSessions.get(clientId);
      if (staffEmail) {
        io.to(staffEmail).emit('receive-message', { clientId, message });
        console.log(`💬 Message from ${clientId} to ${staffEmail}: ${message}`);
      } else {
        socket.emit('message-error', { message: 'No staff connection found' });
      }
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('message-error', { message: 'Failed to send message' });
    }
  });

  socket.on('call-request', ({ clientId, staffEmail }) => {
    try {
      console.log(`📞 Call request from ${clientId} to ${staffEmail}`);

      const clientInfo = connectedUsers.get(socket.id);
      const clientName = clientInfo ? clientInfo.name : 'Client';

      // Generate and store a pending request
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      incomingCallRequests.set(requestId, {
        requestId,
        clientSocketId: socket.id,
        clientId,
        clientName,
        staffEmail,
        timestamp: new Date()
      });

      const payload = {
        requestId,
        clientId,
        clientName,
        staffEmail,
        timestamp: new Date()
      };

      // Notify only the intended staff (by email room) with the requestId
      io.to(staffEmail).emit('incoming-call', payload);
      // Also notify direct socket if we have it
      const staffSocketId = staffEmailSessions.get(staffEmail);
      if (staffSocketId) {
        io.to(staffSocketId).emit('incoming-call', payload);
      }

      socket.emit('call-request-sent', {
        staffEmail,
        requestId,
        message: `Call request sent to ${staffEmail}`
      });
    } catch (error) {
      console.error('Error sending call request:', error);
      socket.emit('call-request-error', { message: 'Failed to send call request' });
    }
  });

  socket.on('call-response', ({ clientId, accepted, staffEmail }) => {
    try {
      console.log(`📞 Call response from ${staffEmail}: ${accepted ? 'accepted' : 'declined'}`);
      
      // Find client socket
      const clientSocketId = clientSessions.get(clientId);
      if (clientSocketId) {
        io.to(clientSocketId).emit('call-response', {
          accepted,
          staffEmail,
          message: accepted ? 'Call accepted!' : 'Call declined'
        });
      }
    } catch (error) {
      console.error('Error handling call response:', error);
      socket.emit('call-response-error', { message: 'Failed to handle call response' });
    }
  });

  // New unified accept/reject for email-targeted requests
  socket.on('call-accepted', async ({ requestId, staffEmail, staffName }) => {
    try {
      const pending = incomingCallRequests.get(requestId);
      if (!pending) {
        console.warn(`⚠️ call-accepted for unknown requestId: ${requestId}`);
        return;
      }

      // Create a new call session
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      activeCalls.set(callId, {
        callId,
        clientSocketId: pending.clientSocketId,
        staffSocketId: socket.id,
        startTime: new Date(),
        status: 'in-progress'
      });

      // Notify client and staff to begin WebRTC
      io.to(pending.clientSocketId).emit('call-accepted', {
        callId,
        staffEmail: staffEmail,
        staffName: staffName || 'Staff'
      });
      io.to(socket.id).emit('call-started', {
        callId,
        clientId: pending.clientId,
        clientName: pending.clientName || 'Client'
      });

      // Broadcast staff busy status when call is accepted
      try {
        if (staffEmail) {
          io.emit('staff_status_update', {
            staffEmail,
            status: 'busy',
            timestamp: new Date().toISOString()
          });
        }
      } catch (_) {}

      // Cleanup pending request
      incomingCallRequests.delete(requestId);
    } catch (error) {
      console.error('Error in call-accepted handler:', error);
      socket.emit('call-error', { message: 'Failed to accept call' });
    }
  });

  socket.on('call-rejected', ({ requestId, staffEmail, reason }) => {
    try {
      const pending = incomingCallRequests.get(requestId);
      if (!pending) return;
      io.to(pending.clientSocketId).emit('call-rejected', {
        staffEmail,
        message: reason || 'Staff declined the call'
      });
      incomingCallRequests.delete(requestId);
    } catch (error) {
      console.error('Error in call-rejected handler:', error);
    }
  });

  // Handle WebRTC call response
  socket.on('webrtc-call-response', ({ callId, accepted, staffEmail }) => {
    try {
      console.log(`🎥 WebRTC call response from ${staffEmail}: ${accepted ? 'accepted' : 'declined'}`);
      console.log(`🎥 Call ID: ${callId}`);
      console.log(`🎥 Active calls:`, Array.from(activeCalls.keys()));
      
      const callSession = activeCalls.get(callId);
      if (callSession) {
        console.log(`🎥 Found call session:`, callSession);
        callSession.status = accepted ? 'accepted' : 'declined';
        
        // Notify client about the response
        console.log(`🎥 Sending response to client socket: ${callSession.clientSocketId}`);
        io.to(callSession.clientSocketId).emit('webrtc-call-response', {
          callId,
          accepted,
          staffEmail,
          staffName: callSession.staffName,
          message: accepted ? 'WebRTC call accepted!' : 'WebRTC call declined'
        });
        
        // If accepted, start WebRTC negotiation and notify client to start video interface
        if (accepted) {
          console.log(`🎥 Starting WebRTC negotiation for call ${callId}`);
          
          // Also send video_call_started event to trigger client video interface
          io.to(callSession.clientSocketId).emit('video_call_started', {
            callId,
            staffName: callSession.staffName,
            staffId: callSession.staffId,
            message: 'Video call started!'
          });
          
          console.log(`🎥 Video call started event sent to client: ${callSession.clientSocketId}`);
        }
      } else {
        console.log(`❌ Call session not found for callId: ${callId}`);
      }
    } catch (error) {
      console.error('Error handling WebRTC call response:', error);
      socket.emit('webrtc-call-response-error', { message: 'Failed to handle WebRTC call response' });
    }
  });

  // Enhanced disconnect handling with session cleanup
  socket.on('disconnect', async () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      if (user.role === 'staff') {
        // Remove from staff sessions by both keys
        staffSessions.delete(user._id.toString());
        try {
          const profile = staffProfiles.find(p => (p.email && user.email && p.email.toLowerCase() === String(user.email).toLowerCase()) || (p.name && user.name && p.name.toLowerCase() === String(user.name).toLowerCase()));
          if (profile && profile.shortName) staffSessions.delete(String(profile.shortName));
        } catch (_) {}

        // Clean up email-based sessions
        if (user.email) {
          staffEmailSessions.delete(user.email);
          if (staffRooms.has(user.email)) {
            staffRooms.get(user.email).delete(socket.id);
            if (staffRooms.get(user.email).size === 0) {
              staffRooms.delete(user.email);
            }
          }

          // Track last seen and broadcast offline status
          const seen = new Date().toISOString();
          lastSeenByEmail.set(user.email, seen);
          io.emit('staff_status_update', {
            staffEmail: user.email,
            status: 'offline',
            lastSeen: seen,
            timestamp: seen
          });
        }
        
        if (isDbConnected() && typeof user.save === 'function') {
          try {
            user.isAvailable = false;
            user.lastActive = new Date();
            await user.save();
          } catch (_) {}
        }

        // Emit updated staff list
        io.emit('staff-list-updated', { 
          staff: Array.from(staffSessions.keys()).map(staffId => {
            const staffUser = connectedUsers.get(staffSessions.get(staffId));
            return { id: staffId, name: staffUser.name, department: staffUser.department };
          })
        });
      } else {
        // Remove from client sessions
        clientSessions.delete(user._id.toString());
      }
      
      connectedUsers.delete(socket.id);
    }
    
    // Clean up waiting calls
    const call = waitingCalls.get(socket.id);
    if (call) {
      if (isDbConnected() && typeof call.save === 'function') {
        try {
          call.status = 'rejected';
          await call.save();
        } catch (_) {}
      }
      waitingCalls.delete(socket.id);
      
      // Emit updated waiting calls count
      io.emit('waiting-calls-updated', { 
        count: waitingCalls.size 
      });
    }

    // Clean up active calls
    for (const [callId, callSession] of activeCalls.entries()) {
      if (callSession.clientSocketId === socket.id || callSession.staffSocketId === socket.id) {
        const otherSocketId = callSession.clientSocketId === socket.id ? 
          callSession.staffSocketId : callSession.clientSocketId;
        
        if (otherSocketId) {
          io.to(otherSocketId).emit('call-ended', { 
            callId, 
            reason: 'Other participant disconnected',
            endedBy: 'System'
          });
        }
        
        activeCalls.delete(callId);
        break;
      }
    }

    console.log('User disconnected:', socket.id);
  });

  // Session Management Events
  socket.on('create_session', async (data) => {
    try {
      const { sessionId, clientId, staffId, purpose } = data;
      
      // Verify session exists in database
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('session_error', { message: 'Session not found' });
        return;
      }

      // Both client and staff join the session room
      socket.join(sessionId);
      
      // Notify both participants about successful session creation
      io.to(sessionId).emit('session_created', {
        sessionId,
        clientId,
        staffId,
        clientName: session.metadata.clientName,
        staffName: session.metadata.staffName,
        purpose: session.metadata.purpose
      });

      console.log(`Session ${sessionId} created - Client: ${clientId}, Staff: ${staffId}`);
    } catch (error) {
      console.error('Error creating session:', error);
      socket.emit('session_error', { message: 'Failed to create session' });
    }
  });

  socket.on('join_session', async (data) => {
    try {
      const { sessionId } = data;
      
      // Verify session exists and user has permission
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('session_error', { message: 'Session not found' });
        return;
      }

      const user = connectedUsers.get(socket.id);
      if (!user) {
        socket.emit('session_error', { message: 'User not authenticated' });
        return;
      }

      // Check if user is part of this session
      const isClient = user.role === 'user' && session.clientId.toString() === user._id.toString();
      const isStaff = user.role === 'staff' && session.staffId === user._id;
      
      if (!isClient && !isStaff) {
        socket.emit('session_error', { message: 'Not authorized to join this session' });
        return;
      }

      // Join the session room
      socket.join(sessionId);
      
      // Update session activity
      await session.updateActivity();

      socket.emit('session_joined', {
        sessionId,
        clientName: session.metadata.clientName,
        staffName: session.metadata.staffName,
        purpose: session.metadata.purpose
      });

      console.log(`User ${user.name} joined session ${sessionId}`);
    } catch (error) {
      console.error('Error joining session:', error);
      socket.emit('session_error', { message: 'Failed to join session' });
    }
  });

  socket.on('leave_session', async (data) => {
    try {
      const { sessionId } = data;
      
      socket.leave(sessionId);
      socket.emit('session_left', { sessionId });
      
      console.log(`User left session ${sessionId}`);
    } catch (error) {
      console.error('Error leaving session:', error);
    }
  });

  socket.on('session_message', async (data) => {
    try {
      const { sessionId, message, messageType = 'text' } = data;
      
      // Verify session exists and user has permission
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('session_error', { message: 'Session not found' });
        return;
      }

      const user = connectedUsers.get(socket.id);
      if (!user) {
        socket.emit('session_error', { message: 'User not authenticated' });
        return;
      }

      // Check if user is part of this session
      const isClient = user.role === 'user' && session.clientId.toString() === user._id.toString();
      const isStaff = user.role === 'staff' && session.staffId === user._id;
      
      if (!isClient && !isStaff) {
        socket.emit('session_error', { message: 'Not authorized to send messages in this session' });
        return;
      }

      // Update session activity and message count
      await session.updateActivity();
      await session.incrementMessageCount();

      // Broadcast message to all users in the session room
      io.to(sessionId).emit('session_message_received', {
        sessionId,
        message,
        messageType,
        senderId: user._id,
        senderName: user.name,
        senderRole: user.role,
        timestamp: new Date()
      });

      console.log(`Message sent in session ${sessionId} by ${user.name}`);
    } catch (error) {
      console.error('Error sending session message:', error);
      socket.emit('session_error', { message: 'Failed to send message' });
    }
  });

  // Global call_initiated event (for Call Updates container)
  socket.on('call_initiated', async (data) => {
    try {
      const { staffId, clientName, callType = 'video' } = data;
      
      // Find the target staff member
      const targetSocketId = staffSessions.get(staffId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call_initiated', {
          sessionId: data.sessionId || 'global-call',
          staffId: staffId,
          clientId: data.clientId || 'unknown',
          clientName: clientName || 'Unknown Client',
          callType: callType,
          callerId: data.callerId || 'unknown',
          callerName: data.callerName || 'Unknown',
          callerRole: data.callerRole || 'user'
        });
        console.log(`Call initiated for staff ${staffId}`);
      } else {
        console.log(`Staff ${staffId} not found or offline`);
      }
    } catch (error) {
      console.error('Error handling global call_initiated:', error);
    }
  });

  socket.on('session_call_initiated', async (data) => {
    try {
      const { sessionId, callType = 'video' } = data;
      
      // Verify session exists and user has permission
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('session_error', { message: 'Session not found' });
        return;
      }

      const user = connectedUsers.get(socket.id);
      if (!user) {
        socket.emit('session_error', { message: 'User not authenticated' });
        return;
      }

      // Check if user is part of this session
      const isClient = user.role === 'user' && session.clientId.toString() === user._id.toString();
      const isStaff = user.role === 'staff' && session.staffId === user._id;
      
      if (!isClient && !isStaff) {
        socket.emit('session_error', { message: 'Not authorized to initiate calls in this session' });
        return;
      }

      // Update session activity and call count
      await session.updateActivity();
      await session.incrementCallCount();

      // Only notify the other participant (not the caller)
      const targetRole = user.role === 'user' ? 'staff' : 'user';
      const targetSocketId = targetRole === 'staff' ? 
        staffSessions.get(session.staffId) : 
        clientSessions.get(session.clientId.toString());

      if (targetSocketId) {
        // Emit session-specific notification
        io.to(targetSocketId).emit('session_call_notification', {
          sessionId,
          callType,
          callerId: user._id,
          callerName: user.name,
          callerRole: user.role
        });

        // Also emit global call_initiated event for Call Updates container
        io.to(targetSocketId).emit('call_initiated', {
          sessionId,
          staffId: session.staffId,
          clientId: session.clientId,
          clientName: session.metadata.clientName,
          callType,
          callerId: user._id,
          callerName: user.name,
          callerRole: user.role
        });
      }

      console.log(`Call initiated in session ${sessionId} by ${user.name}`);
    } catch (error) {
      console.error('Error initiating session call:', error);
      socket.emit('session_error', { message: 'Failed to initiate call' });
    }
  });

  // Global call_accepted event
  socket.on('call_accepted', async (data) => {
    try {
      const { sessionId, staffId } = data;
      
      // Notify all participants in the session room
      io.to(sessionId).emit('call_accepted', {
        sessionId,
        staffId,
        acceptedBy: connectedUsers.get(socket.id)?.name || 'Unknown'
      });

      console.log(`Call accepted for session ${sessionId}`);
    } catch (error) {
      console.error('Error accepting call:', error);
    }
  });

  socket.on('session_call_accepted', async (data) => {
    try {
      const { sessionId, callId } = data;
      
      // Notify all participants in the session room
      io.to(sessionId).emit('session_call_accepted', {
        sessionId,
        callId,
        acceptedBy: connectedUsers.get(socket.id)?.name || 'Unknown'
      });

      console.log(`Call accepted in session ${sessionId}`);
    } catch (error) {
      console.error('Error accepting session call:', error);
      socket.emit('session_error', { message: 'Failed to accept call' });
    }
  });

  socket.on('session_call_declined', async (data) => {
    try {
      const { sessionId, callId } = data;
      
      // Notify all participants in the session room
      io.to(sessionId).emit('session_call_declined', {
        sessionId,
        callId,
        declinedBy: connectedUsers.get(socket.id)?.name || 'Unknown'
      });

      console.log(`Call declined in session ${sessionId}`);
    } catch (error) {
      console.error('Error declining session call:', error);
      socket.emit('session_error', { message: 'Failed to decline call' });
    }
  });

  // Global call_ended event
  socket.on('call_ended', async (data) => {
    try {
      const { sessionId } = data;
      
      // Notify all participants in the session room
      io.to(sessionId).emit('call_ended', {
        sessionId,
        endedBy: connectedUsers.get(socket.id)?.name || 'Unknown'
      });

      console.log(`Call ended for session ${sessionId}`);
    } catch (error) {
      console.error('Error ending call:', error);
    }
  });

  socket.on('session_call_ended', async (data) => {
    try {
      const { sessionId, callId } = data;
      
      // Notify all participants in the session room
      io.to(sessionId).emit('session_call_ended', {
        sessionId,
        callId,
        endedBy: connectedUsers.get(socket.id)?.name || 'Unknown'
      });

      console.log(`Call ended in session ${sessionId}`);
    } catch (error) {
      console.error('Error ending session call:', error);
      socket.emit('session_error', { message: 'Failed to end call' });
    }
  });

  socket.on('session_ended', async (data) => {
    try {
      const { sessionId } = data;
      
      // Verify session exists and user has permission
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('session_error', { message: 'Session not found' });
        return;
      }

      const user = connectedUsers.get(socket.id);
      if (!user) {
        socket.emit('session_error', { message: 'User not authenticated' });
        return;
      }

      // Check if user is part of this session
      const isClient = user.role === 'user' && session.clientId.toString() === user._id.toString();
      const isStaff = user.role === 'staff' && session.staffId === user._id;
      
      if (!isClient && !isStaff) {
        socket.emit('session_error', { message: 'Not authorized to end this session' });
        return;
      }

      // End the session in database
      await session.endSession();

      // Notify all participants in the session room
      io.to(sessionId).emit('session_ended', {
        sessionId,
        endedBy: user.name
      });

      // Remove all users from the session room
      const room = io.sockets.adapter.rooms.get(sessionId);
      if (room) {
        for (const socketId of room) {
          io.sockets.sockets.get(socketId)?.leave(sessionId);
        }
      }

      console.log(`Session ${sessionId} ended by ${user.name}`);
    } catch (error) {
      console.error('Error ending session:', error);
      socket.emit('session_error', { message: 'Failed to end session' });
    }
  });

  // Timetable Management Events
  socket.on('get_staff_timetable', async (data) => {
    try {
      const { staffId } = data;
      
      if (!isDbConnected()) {
        socket.emit('timetable_entries', { entries: [] });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        socket.emit('timetable_entries', { entries: [] });
        return;
      }

      socket.emit('timetable_entries', { entries: timetable.entries });
    } catch (error) {
      console.error('Error getting staff timetable:', error);
      socket.emit('timetable_error', { message: 'Failed to fetch timetable' });
    }
  });

  // Direct timetable loading from StaffTimetable model
  socket.on('get_staff_timetable_direct', async (data) => {
    try {
      const { staffId, email } = data;
      
      if (!isDbConnected()) {
        socket.emit('staff_timetable_direct', { success: false, message: 'Database not connected' });
        return;
      }

      console.log('Loading timetable for staff:', { staffId, email });

      // Try to find staff by ID first, then by email
      let staff = null;
      if (staffId) {
        staff = await Staff.findById(staffId);
      }
      
      if (!staff && email) {
        staff = await Staff.findOne({ email: email });
      }

      if (!staff) {
        console.log('Staff not found:', { staffId, email });
        socket.emit('staff_timetable_direct', { success: false, message: 'Staff not found' });
        return;
      }

      // Get timetable from StaffTimetable model
      const staffTimetable = await StaffTimetable.findOne({ 
        staffId: staff._id.toString(), 
        isActive: true 
      }).sort({ lastUpdated: -1 });

      if (staffTimetable && staffTimetable.entries && staffTimetable.entries.length > 0) {
        console.log('Found timetable with', staffTimetable.entries.length, 'entries for', staff.name);
        socket.emit('staff_timetable_direct', { 
          success: true, 
          entries: staffTimetable.entries,
          staffName: staff.name,
          academicYear: staffTimetable.academicYear,
          semester: staffTimetable.semester
        });
      } else {
        console.log('No timetable found for', staff.name);
        socket.emit('staff_timetable_direct', { 
          success: false, 
          message: 'No timetable found for this staff member',
          staffName: staff.name
        });
      }
    } catch (error) {
      console.error('Get staff timetable direct error:', error);
      socket.emit('staff_timetable_direct', { success: false, message: 'Failed to fetch timetable' });
    }
  });

  // Real-time teacher availability check
  socket.on('check_teacher_availability', async (data) => {
    try {
      const { teacherName, day, clientId } = data;
      
      console.log('🔍 Checking availability for teacher:', teacherName);

      // First, check staff-profiles.js for matching staff
      const staffProfile = staffProfiles.find(s => {
        const lowerTeacherName = teacherName.toLowerCase();
        const lowerStaffName = s.name.toLowerCase();
        
        // Exact match
        if (lowerStaffName === lowerTeacherName) return true;
        
        // Partial match (e.g., "Anita" matches "Prof. Anitha C S")
        if (lowerStaffName.includes(lowerTeacherName) || lowerTeacherName.includes(lowerStaffName)) return true;
        
        // First name match
        const firstName = lowerStaffName.replace(/^(prof\.|dr\.|mrs?\.|ms\.)\s*/i, '').split(/\s+/)[0];
        if (firstName === lowerTeacherName || lowerTeacherName.includes(firstName)) return true;
        
        // Email match
        if (s.email && s.email.toLowerCase().includes(lowerTeacherName.replace(/['\s]/g, ''))) return true;
        
        // Short name match
        if (s.shortName && s.shortName.toLowerCase() === lowerTeacherName) return true;
        
        return false;
      });

      if (staffProfile) {
        console.log('✅ Found teacher in staff-profiles:', staffProfile.name);

        const nowStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

        const staffEmail = staffProfile.email;
        const staffSocketId = staffEmail ? staffEmailSessions.get(staffEmail) : null;
        const isOnlineBasic = staffSessions.has(staffProfile.shortName) || staffEmailSessions.has(staffEmail);

        // Determine if in an active call (busy)
        let isBusy = false;
        if (staffSocketId) {
          for (const [, session] of activeCalls.entries()) {
            if (session.staffSocketId === staffSocketId) { isBusy = true; break; }
          }
        }

        // Optionally enrich with timetable-based "in class" if DB has entries
        let inClass = false;
        if (isDbConnected()) {
          try {
            const staffDoc = await Staff.findOne({ $or: [
              { email: staffEmail },
              { name: new RegExp(staffProfile.name, 'i') }
            ]});
            if (staffDoc) {
              const staffTimetable = await StaffTimetable.findOne({ staffId: staffDoc._id.toString(), isActive: true }).sort({ lastUpdated: -1 });
              if (staffTimetable?.entries?.length) {
                const avail = checkTeacherAvailability(staffTimetable.entries, day);
                // If checking current day (or unspecified) and not available => in class
                const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
                const targetDay = day || today;
                if ((!day || day === today) && avail && avail.isAvailable === false) {
                  inClass = true;
                }
              }
            }
          } catch (e) {
            console.warn('⚠️ Timetable enrichment failed:', e.message);
          }
        }

        // Compute status label
        let status = 'offline';
        if (isOnlineBasic) status = 'online';
        if (inClass) status = 'in_class';
        if (isBusy) status = 'busy';

        // Compose smart message
        let message;
        if (status === 'online') {
          message = `${staffProfile.name} is currently available for video calls.`;
        } else if (status === 'busy') {
          message = `${staffProfile.name} is currently on a call. Please try again soon.`;
        } else if (status === 'in_class') {
          message = `${staffProfile.name} is currently in a class. They will be available soon.`;
        } else {
          const lastSeen = staffEmail ? lastSeenByEmail.get(staffEmail) : null;
          message = `${staffProfile.name} is currently offline.${lastSeen ? ` Last seen at ${new Date(lastSeen).toLocaleTimeString()}.` : ''}`;
        }

        socket.emit('teacher_availability_response', { 
          success: true, 
          status,
          isAvailable: status === 'online',
          isOnline: isOnlineBasic,
          isBusy,
          inClass,
          message,
          teacherName: staffProfile.name,
          staffEmail: staffEmail,
          staffDepartment: staffProfile.department,
          currentTime: nowStr,
          clientId: clientId 
        });
        return;
      }

      // If not in staff-profiles, check database
      if (!isDbConnected()) {
        socket.emit('teacher_availability_response', { 
          success: false, 
          message: `Teacher "${teacherName}" not found. Please check the name and try again.`,
          clientId: clientId 
        });
        return;
      }

      // Find staff by name (case insensitive) in database
      const staff = await Staff.findOne({ 
        name: { $regex: new RegExp(teacherName, 'i') } 
      });

      if (!staff) {
        console.log('❌ Teacher not found:', teacherName);
        // Try alternative search methods
        const alternativeStaff = await Staff.findOne({
          $or: [
            { name: { $regex: new RegExp(teacherName.replace(/\s+/g, '.*'), 'i') } },
            { email: { $regex: new RegExp(teacherName, 'i') } }
          ]
        });
        
        if (alternativeStaff) {
          console.log('✅ Found teacher via alternative search:', alternativeStaff.name);
          const staffTimetable = await StaffTimetable.findOne({ 
            staffId: alternativeStaff._id.toString(), 
            isActive: true 
          }).sort({ lastUpdated: -1 });
          
          if (staffTimetable && staffTimetable.entries && staffTimetable.entries.length > 0) {
            console.log('📅 Found timetable with', staffTimetable.entries.length, 'entries');
            const availability = checkTeacherAvailability(staffTimetable.entries, day);
            
            socket.emit('teacher_availability_response', { 
              success: true, 
              isAvailable: availability.isAvailable,
              message: availability.message,
              teacherName: alternativeStaff.name,
              currentTime: availability.currentTime,
              nextClass: availability.nextClass,
              clientId: clientId 
            });
            return;
          }
        }
        
        socket.emit('teacher_availability_response', { 
          success: false, 
          message: `Teacher "${teacherName}" not found`,
          clientId: clientId 
        });
        return;
      }

      console.log('✅ Found teacher:', staff.name, 'ID:', staff._id);

      // Get current timetable
      const staffTimetable = await StaffTimetable.findOne({ 
        staffId: staff._id.toString(), 
        isActive: true 
      }).sort({ lastUpdated: -1 });

      if (!staffTimetable || !staffTimetable.entries || staffTimetable.entries.length === 0) {
        console.log('❌ No timetable found for', staff.name);
        socket.emit('teacher_availability_response', { 
          success: true, 
          isAvailable: true,
          message: `${staff.name} is free (no timetable found)`,
          teacherName: staff.name,
          clientId: clientId 
        });
        return;
      }

      console.log('📅 Found timetable with', staffTimetable.entries.length, 'entries for', staff.name);

      // Check current availability
      const availability = checkTeacherAvailability(staffTimetable.entries, day);
      
      console.log('🕐 Availability check result:', availability);
      
      socket.emit('teacher_availability_response', { 
        success: true, 
        status: availability.isAvailable ? 'online' : 'in_class',
        isAvailable: availability.isAvailable,
        message: availability.message,
        teacherName: staff.name,
        currentTime: availability.currentTime,
        nextClass: availability.nextClass,
        clientId: clientId 
      });

    } catch (error) {
      console.error('❌ Check teacher availability error:', error);
      socket.emit('teacher_availability_response', { 
        success: false, 
        message: 'Failed to check availability',
        clientId: data.clientId 
      });
    }
  });

  socket.on('add_timetable_entry', async (data) => {
    try {
      const { staffId, day, timeSlot, activity, subject, room, batch, semester, notes, isRecurring } = data;
      
      if (!isDbConnected()) {
        socket.emit('timetable_error', { message: 'Database not connected' });
        return;
      }

      // Find or create staff timetable
      let timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        timetable = new StaffTimetable({
          staffId: staffId,
          academicYear: '2024-25',
          semester: '1st Semester',
          entries: []
        });
      }

      // Add new entry
      const newEntry = {
        day,
        timeSlot,
        activity,
        subject: subject || '',
        room: room || '',
        batch: batch || '',
        semester: semester || '',
        notes: notes || '',
        isRecurring: isRecurring || true,
        startDate: new Date(),
        exceptions: []
      };

      timetable.entries.push(newEntry);
      timetable.lastUpdated = new Date();
      await timetable.save();

      socket.emit('timetable_entry_added', { entry: newEntry });
    } catch (error) {
      console.error('Error adding timetable entry:', error);
      socket.emit('timetable_error', { message: 'Failed to add timetable entry' });
    }
  });

  socket.on('update_timetable_entry', async (data) => {
    try {
      const { id, staffId, day, timeSlot, activity, subject, room, batch, semester, notes, isRecurring } = data;
      
      if (!isDbConnected()) {
        socket.emit('timetable_error', { message: 'Database not connected' });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        socket.emit('timetable_error', { message: 'Timetable not found' });
        return;
      }

      const entryIndex = timetable.entries.findIndex(entry => entry._id.toString() === id);
      if (entryIndex === -1) {
        socket.emit('timetable_error', { message: 'Entry not found' });
        return;
      }

      // Update entry
      timetable.entries[entryIndex] = {
        ...timetable.entries[entryIndex],
        day,
        timeSlot,
        activity,
        subject: subject || '',
        room: room || '',
        batch: batch || '',
        semester: semester || '',
        notes: notes || '',
        isRecurring: isRecurring || true
      };

      timetable.lastUpdated = new Date();
      await timetable.save();

      socket.emit('timetable_entry_updated', { entry: timetable.entries[entryIndex] });
    } catch (error) {
      console.error('Error updating timetable entry:', error);
      socket.emit('timetable_error', { message: 'Failed to update timetable entry' });
    }
  });

  socket.on('delete_timetable_entry', async (data) => {
    try {
      const { entryId, staffId } = data;
      
      if (!isDbConnected()) {
        socket.emit('timetable_error', { message: 'Database not connected' });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        socket.emit('timetable_error', { message: 'Timetable not found' });
        return;
      }

      timetable.entries = timetable.entries.filter(entry => entry._id.toString() !== entryId);
      timetable.lastUpdated = new Date();
      await timetable.save();

      socket.emit('timetable_entry_deleted', { entryId });
    } catch (error) {
      console.error('Error deleting timetable entry:', error);
      socket.emit('timetable_error', { message: 'Failed to delete timetable entry' });
    }
  });

  socket.on('get_timetable_entry', async (data) => {
    try {
      const { entryId, staffId } = data;
      
      if (!isDbConnected()) {
        socket.emit('timetable_error', { message: 'Database not connected' });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        socket.emit('timetable_error', { message: 'Timetable not found' });
        return;
      }

      const entry = timetable.entries.find(entry => entry._id.toString() === entryId);
      if (!entry) {
        socket.emit('timetable_error', { message: 'Entry not found' });
        return;
      }

      socket.emit('timetable_entry', { entry });
    } catch (error) {
      console.error('Error getting timetable entry:', error);
      socket.emit('timetable_error', { message: 'Failed to fetch timetable entry' });
    }
  });

  socket.on('get_weekly_schedule', async (data) => {
    try {
      const { staffId } = data;
      
      if (!isDbConnected()) {
        socket.emit('weekly_schedule', { schedule: {} });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        socket.emit('weekly_schedule', { schedule: {} });
        return;
      }

      // Group entries by day
      const schedule = {};
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      
      days.forEach(day => {
        schedule[day] = timetable.entries
          .filter(entry => entry.day === day)
          .sort((a, b) => a.timeSlot.start.localeCompare(b.timeSlot.start));
      });

      socket.emit('weekly_schedule', { schedule });
    } catch (error) {
      console.error('Error getting weekly schedule:', error);
      socket.emit('timetable_error', { message: 'Failed to fetch weekly schedule' });
    }
  });

  socket.on('get_today_schedule', async (data) => {
    try {
      const { staffId } = data;
      
      if (!isDbConnected()) {
        socket.emit('today_schedule', { schedule: [] });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        socket.emit('today_schedule', { schedule: [] });
        return;
      }

      // Get today's schedule
      const todaySchedule = timetable.getTodaySchedule();
      socket.emit('today_schedule', { schedule: todaySchedule });
    } catch (error) {
      console.error('Error getting today schedule:', error);
      socket.emit('timetable_error', { message: 'Failed to fetch today schedule' });
    }
  });

  socket.on('clear_all_timetable_entries', async (data) => {
    try {
      const { staffId } = data;
      
      if (!isDbConnected()) {
        socket.emit('timetable_error', { message: 'Database not connected' });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        socket.emit('timetable_cleared', { message: 'No timetable entries to clear' });
        return;
      }

      // Clear all entries
      timetable.entries = [];
      timetable.lastUpdated = new Date();
      await timetable.save();

      socket.emit('timetable_cleared', { message: 'All timetable entries cleared successfully' });
      socket.emit('timetable_entries', { entries: [] });
    } catch (error) {
      console.error('Error clearing timetable entries:', error);
      socket.emit('timetable_error', { message: 'Failed to clear timetable entries' });
    }
  });

  socket.on('update_timetable_settings', async (data) => {
    try {
      const { staffId, academicYear, semester } = data;
      
      if (!isDbConnected()) {
        socket.emit('timetable_error', { message: 'Database not connected' });
        return;
      }

      const timetable = await StaffTimetable.findOne({ 
        staffId: staffId, 
        isActive: true 
      });

      if (!timetable) {
        // Create new timetable with settings
        const newTimetable = new StaffTimetable({
          staffId: staffId,
          academicYear: academicYear || '2024-25',
          semester: semester || '1st Semester',
          entries: []
        });
        await newTimetable.save();
      } else {
        // Update existing timetable settings
        timetable.academicYear = academicYear || timetable.academicYear;
        timetable.semester = semester || timetable.semester;
        timetable.lastUpdated = new Date();
        await timetable.save();
      }

      socket.emit('timetable_settings_updated', { academicYear, semester });
    } catch (error) {
      console.error('Error updating timetable settings:', error);
      socket.emit('timetable_error', { message: 'Failed to update timetable settings' });
    }
  });

  // Video call request handler
  // DUPLICATE HANDLER - COMMENTED OUT
  // socket.on('video-call-request', async (data) => {
  //   try {
  //     console.log('🎥 Video call request received:', data);
  //     
  //     const { staffId, staffName, clientName, clientSocketId } = data;
      
  //     // Create call session
  //     const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  //     
  //     // Store call session
  //     const callSession = {
  //       callId,
  //       clientId: clientSocketId,
  //       staffId,
  //       staffName,
  //       clientName,
  //       status: 'requested',
  //       startTime: new Date(),
  //       clientSocketId: socket.id
  //     };
  //     
  //     activeCalls.set(callId, callSession);
  //     
  //     // Broadcast video call request to all staff members
  //     console.log(`📤 Broadcasting video call request to all staff for ${staffName}`);
  //     io.emit('incoming-video-call-request', {
  //       callId,
  //       staffName,
  //       clientName,
  //       timestamp: new Date(),
  //       broadcast: true
  //     });
  //     
  //     // Also broadcast call update to all staff
  //     io.emit('call-update', {
  //       type: 'incoming-video-call-request',
  //       callId,
  //       staffName,
  //       clientName,
  //       timestamp: new Date(),
  //       status: 'incoming',
  //       broadcast: true
  //     });
  //     
  //     // Send confirmation to client
  //     socket.emit('video-call-request-sent', {
  //       callId,
  //       staffName,
  //       message: `Video call request sent to ${staffName}. Waiting for response...`
  //     });
  //     
  //     console.log(`🎥 Video call request broadcasted: ${callId} for ${staffName}`);
  //     
  //   } catch (error) {
  //     console.error('Error handling video call request:', error);
  //     socket.emit('video-call-error', { message: 'Failed to send video call request' });
  //   }
  // });

  // Handle staff accepting video call
  socket.on('accept-video-call', async (data) => {
    try {
      console.log('✅ Staff accepting video call:', data);
      
      const { callId, staffId, staffName } = data;
      const callSession = activeCalls.get(callId);
      
      if (!callSession) {
        console.error('Call session not found:', callId);
        return;
      }
      
      // Update call status
      callSession.status = 'accepted';
      callSession.staffId = staffId;
      callSession.staffName = staffName;
      
      // Notify client that call was accepted
      io.to(callSession.clientSocketId).emit('video-call-accepted', {
        callId,
        staffName,
        staffId,
        message: `${staffName} accepted your video call request!`
      });
      
      // Notify all staff that call was accepted
      io.emit('call-update', {
        type: 'video-call-accepted',
        callId,
        staffName,
        clientName: callSession.clientName,
        timestamp: new Date(),
        status: 'accepted',
        broadcast: true
      });
      
      console.log(`✅ Video call accepted: ${callId} by ${staffName}`);
      
    } catch (error) {
      console.error('Error handling video call acceptance:', error);
      socket.emit('video-call-error', { message: 'Failed to accept video call' });
    }
  });

  // Handle staff rejecting video call
  socket.on('reject-video-call', async (data) => {
    try {
      console.log('❌ Staff rejecting video call:', data);
      
      const { callId, staffId, staffName } = data;
      const callSession = activeCalls.get(callId);
      
      if (!callSession) {
        console.error('Call session not found:', callId);
        return;
      }
      
      // Update call status
      callSession.status = 'rejected';
      callSession.staffId = staffId;
      callSession.staffName = staffName;
      
      // Notify client that call was rejected
      io.to(callSession.clientSocketId).emit('video-call-rejected', {
        callId,
        staffName,
        staffId,
        message: `${staffName} is not available for video calls right now.`
      });
      
      // Notify all staff that call was rejected
      io.emit('call-update', {
        type: 'video-call-rejected',
        callId,
        staffName,
        clientName: callSession.clientName,
        timestamp: new Date(),
        status: 'rejected',
        broadcast: true
      });
      
      // Remove call from active calls
      activeCalls.delete(callId);
      
      console.log(`❌ Video call rejected: ${callId} by ${staffName}`);
      
    } catch (error) {
      console.error('Error handling video call rejection:', error);
      socket.emit('video-call-error', { message: 'Failed to reject video call' });
    }
  });

  // WebRTC Video Call Handlers
  socket.on('call_offer', async (data) => {
    try {
      const { callId, sessionId, offer } = data;
      console.log(`📞 Call offer received for ${sessionId || callId}`);
      
      // Forward the offer to the target user
      const targetRoom = sessionId || callId;
      socket.to(targetRoom).emit('call_offer', {
        callId,
        sessionId,
        offer,
        from: connectedUsers.get(socket.id)?.name || 'Unknown'
      });
    } catch (error) {
      console.error('Error handling call offer:', error);
    }
  });

  socket.on('call_answer', async (data) => {
    try {
      const { callId, sessionId, answer } = data;
      console.log(`📞 Call answer received for ${sessionId || callId}`);
      
      // Forward the answer back to the caller
      const targetRoom = sessionId || callId;
      socket.to(targetRoom).emit('call_answer', {
        callId,
        sessionId,
        answer,
        from: connectedUsers.get(socket.id)?.name || 'Unknown'
      });
    } catch (error) {
      console.error('Error handling call answer:', error);
    }
  });

  socket.on('ice_candidate', async (data) => {
    try {
      const { callId, sessionId, candidate } = data;
      
      // Forward ICE candidate to the other peer
      const targetRoom = sessionId || callId;
      socket.to(targetRoom).emit('ice_candidate', {
        callId,
        sessionId,
        candidate,
        from: connectedUsers.get(socket.id)?.name || 'Unknown'
      });
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
    }
  });

  // Call ended handler
  socket.on('call_ended', async (data) => {
    try {
      console.log('📞 Call ended:', data);
      
      const { callId, duration } = data;
      const callSession = activeCalls.get(callId);
      
      if (callSession) {
        // Update call session with duration
        callSession.duration = duration;
        callSession.endTime = new Date();
        callSession.status = 'completed';
        
        // Notify client that call ended
        io.to(callSession.clientSocketId).emit('call_ended', {
          callId,
          duration,
          message: 'Video call ended successfully'
        });
        
        // Notify staff that call ended and add to call log
        io.emit('call_ended', {
          callId,
          duration,
          clientName: callSession.clientName,
          staffName: callSession.staffName,
          message: 'Video call completed'
        });
        
        console.log(`📞 Call completed: ${callId} - Duration: ${duration}s`);
      }
    } catch (error) {
      console.error('Error handling call ended:', error);
    }
  });

  // Generate appointment QR code handler
  socket.on('generate_appointment_qr', async (data) => {
    try {
      console.log('📱 Generating appointment QR code:', data);
      
      const { callId, appointmentDetails, clientId } = data;
      
      // Generate QR code data
      const qrData = {
        appointmentId: appointmentDetails.appointmentId,
        clientName: appointmentDetails.clientName,
        staffName: appointmentDetails.staffName,
        appointmentDate: appointmentDetails.appointmentDate,
        purpose: appointmentDetails.purpose,
        status: appointmentDetails.status,
        generatedAt: new Date().toISOString()
      };
      
      // Convert to JSON string for QR code
      const qrCodeData = JSON.stringify(qrData);
      
      // Send QR code to client
      io.to(clientId).emit('appointment_qr_generated', {
        appointmentDetails: appointmentDetails,
        qrCodeData: qrCodeData,
        message: 'Your appointment QR code is ready!'
      });
      
      // Notify staff that QR was generated
      socket.emit('qr_code_generated', {
        callId,
        appointmentId: appointmentDetails.appointmentId,
        message: 'QR code generated and sent to client'
      });
      
      console.log(`📱 QR code generated for appointment: ${appointmentDetails.appointmentId}`);
      
    } catch (error) {
      console.error('Error generating appointment QR code:', error);
      socket.emit('qr_generation_error', { 
        message: 'Failed to generate QR code' 
      });
    }
  });

  // Video call accepted handler
  socket.on('video_call_accepted', async (data) => {
    try {
      console.log('✅ Video call accepted:', data);
      
      const { callId, staffId } = data;
      const callSession = activeCalls.get(callId);
      
      if (callSession) {
        // Update call status
        callSession.status = 'active';
        callSession.staffId = staffId;
        callSession.startTime = new Date();
        
        // Notify client that call was accepted and start video
        io.to(callSession.clientSocketId).emit('video-call-accepted', {
          callId,
          staffName: callSession.staffName,
          staffId: staffId,
          message: 'Video call accepted by staff!'
        });
        
        // Also emit video_call_started for the video interface
        io.to(callSession.clientSocketId).emit('video_call_started', {
          callId,
          staffName: callSession.staffName,
          message: 'Video call started!'
        });
        
        // Notify staff to start video call interface
        socket.emit('video_call_accepted', {
          callId,
          clientName: callSession.clientName,
          clientId: callSession.clientId
        });
        
        console.log(`✅ Video call started: ${callId}`);
      }
    } catch (error) {
      console.error('Error handling video call accepted:', error);
    }
  });
});

// API Routes

// College AI routes
app.use('/api/college', collegeRoutes);

// n8n Integration routes
app.use('/api/n8n', n8nRoutes);

// Timetable routes
app.use('/api/timetable', timetableRoutes);

// Call management routes
app.use('/api/calls', callRoutes);

// Appointment management routes
app.use('/api/appointments', appointmentRoutes);
app.use('/api/sessions', sessionRoutes);
// Staff portal routes (auth, timetable CRUD, call logs)
app.use('/api/staff', staffPortalRoutes);

// Staff login using staff-profiles.js data (for staff interface)
app.post('/api/staff/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const staff = staffProfiles.find(s => s.email.toLowerCase() === String(email || '').toLowerCase());
    if (!staff || staff.password !== password) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      {
        staffId: staff.shortName,
        name: staff.name,
        department: staff.department,
        email: staff.email,
        shortName: staff.shortName,
        subjects: staff.subjects
      },
      process.env.JWT_SECRET || 'demo_secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      staff: {
        _id: staff.shortName,
        name: staff.name,
        email: staff.email,
        department: staff.department,
        designation: staff.name.includes('Prof.') ? 'Professor' : 'Assistant Professor',
        shortName: staff.shortName,
        subjects: staff.subjects
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed' });
  }
});

// API routes moved to top of file to avoid static middleware conflicts

// Authentication routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role, department } = req.body;
    
    // Check if MongoDB is connected
    if (!isDbConnected()) {
      return res.status(503).json({ error: 'Database not available. Please try again later.' });
    }
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const user = new User({
      name,
      email,
      password: hashedPassword,
      role,
      department
    });
    await user.save();

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'demo_secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Check if MongoDB is connected
    if (!isDbConnected()) {
      return res.status(503).json({ error: 'Database not available. Please try again later.' });
    }
    
    const user = await User.findOne({ email });
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'demo_secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed: ' + error.message });
  }
});

// Protected routes
app.get('/api/calls/waiting', authenticateToken, async (req, res) => {
  try {
    if (isDbConnected()) {
      const calls = await Call.find({ status: 'waiting' })
        .populate('clientId', 'name email')
        .sort({ createdAt: 1 });
      res.json(calls);
    } else {
      res.json(Array.from(demoCalls.values()));
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch waiting calls' });
  }
});

app.get('/api/calls/my-calls', authenticateToken, async (req, res) => {
  try {
    if (isDbConnected()) {
      const calls = await Call.find({ staffId: req.user._id })
        .populate('clientId', 'name email')
        .sort({ createdAt: -1 });
      res.json(calls);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// Upcoming appointments for the logged-in staff (if not already present)
app.get('/api/appointments/upcoming', authenticateToken, async (req, res) => {
  try {
    if (isDbConnected()) {
      const items = await Appointment.findUpcoming(req.user._id, 10);
      res.json(items);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch upcoming appointments' });
  }
});

app.get('/api/staff/available', async (req, res) => {
  try {
    // Always return actively connected staff derived from current sessions
    const staff = Array.from(staffSessions.keys()).map((staffId) => {
      const socketId = staffSessions.get(staffId);
      const user = connectedUsers.get(socketId);
      return {
        _id: staffId,
        name: user?.name || 'Staff',
        department: user?.department || 'General',
        lastActive: user?.lastActive || new Date()
      };
    });
    res.json(staff);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch available staff' });
  }
});

// Static staff directory from staff-profiles.js
app.get('/api/staff/list', (req, res) => {
  try {
    const list = staffProfiles.map(s => ({
      _id: s.shortName,
      name: s.name,
      email: s.email,
      department: s.department,
      shortName: s.shortName,
      subjects: s.subjects
    }));
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch staff list' });
  }
});

// Main interface route
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Staff interface routes
app.get('/staff', (req, res) => {
  // Redirect to the main staff interface
  res.redirect('/staff-interface');
});

app.get('/staff-login', (req, res) => {
  // Redirect to the main staff interface
  res.redirect('/staff-interface');
});

app.get('/staff-dashboard', (req, res) => {
  // Redirect to the main staff interface
  res.redirect('/staff-interface');
});

app.get('/staff-interface', (req, res) => {
  res.sendFile(__dirname + '/public/staff-interface.html');
});

// Dynamic per-staff interface route (public HTML; APIs are protected)
app.get('/staff-interface/:username', (req, res) => {
  res.sendFile(__dirname + '/public/staff-interface.html');
});

// Video call functionality is now integrated into main interfaces

// Staff registration route
app.get('/register', (req, res) => {
  res.sendFile(__dirname + '/public/register.html');
});

// College demo route
app.get('/college-demo', (req, res) => {
  res.sendFile(__dirname + '/public/college-demo.html');
});

// n8n test route
app.get('/n8n-test', (req, res) => {
  res.sendFile(__dirname + '/public/n8n-test.html');
});

app.get('/test-routes', (req, res) => {
  res.sendFile(__dirname + '/public/test-routes.html');
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const healthData = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Clara AI Reception System',
    connectedUsers: connectedUsers.size,
    waitingCalls: waitingCalls.size,
    databaseStatus: isDbConnected() ? 'connected' : 'disconnected'
  };

  // Send health data to n8n webhook
  try {
    await n8nService.sendHealthData(healthData);
  } catch (n8nError) {
    console.error('❌ n8n health data processing error:', n8nError.message);
    // Don't fail the main flow if n8n is down
  }

  res.json(healthData);
});

// QR Code Generation API
app.post('/api/qr/generate', async (req, res) => {
  try {
    const { data, options = {} } = req.body;
    
    if (!data) {
      return res.status(400).json({ error: 'Data is required for QR code generation' });
    }

    const QRCode = require('qrcode');
    
    // Default options
    const qrOptions = {
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 256,
      ...options
    };

    // Generate QR code as data URL
    const qrCodeDataURL = await QRCode.toDataURL(data, qrOptions);
    
    res.json({
      success: true,
      qrCode: qrCodeDataURL,
      data: data,
      options: qrOptions
    });
  } catch (error) {
    console.error('QR Code generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate QR code',
      details: error.message 
    });
  }
});

app.get('/api/qr/test', (req, res) => {
  res.sendFile(__dirname + '/public/test-qr-final.html');
});

// Edge TTS API endpoint
app.post('/api/tts/speak', async (req, res) => {
  try {
    const { text, language, voice, rate = '+0%', pitch = '+0Hz', emotionalContext } = req.body;
    
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Text is required and must be a non-empty string'
      });
    }

    // Limit text length to prevent abuse
    if (text.length > 5000) {
      return res.status(400).json({
        success: false,
        error: 'Text too long. Maximum 5000 characters allowed.'
      });
    }

        // Use temporary file approach for better Unicode handling
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        
        // Create temporary file with UTF-8 encoding
        const tempFile = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.txt`);
        
        try {
          // Write text to temporary file with UTF-8 encoding and BOM
          fs.writeFileSync(tempFile, '\uFEFF' + text, 'utf8');
          
          // Call Python script with file path and emotional context
          const command = `python "${__dirname}/services/edgeTTS.py" "${tempFile}" "${language || ''}" "${voice || ''}" "${emotionalContext || 'casual'}"`;
          
          exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
            // Clean up temporary file
            try {
              if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
              }
            } catch (cleanupError) {
              console.error('Failed to clean up temp file:', cleanupError);
            }
            
            if (error) {
              console.error('Python process error:', error);
              res.status(500).json({
                success: false,
                error: stderr || 'TTS generation failed',
                fallback: 'browser_tts'
              });
              return;
            }

            if (stderr) {
              console.error('Python stderr:', stderr);
            }

            try {
              const result = JSON.parse(stdout);
              if (result.success) {
                res.json(result);
              } else {
                res.status(500).json(result);
              }
            } catch (parseError) {
              console.error('Failed to parse TTS result:', parseError);
              res.status(500).json({
                success: false,
                error: 'Failed to process TTS response',
                fallback: 'browser_tts'
              });
            }
          });
        } catch (writeError) {
          console.error('Failed to write temp file:', writeError);
          res.status(500).json({
            success: false,
            error: 'Failed to process text',
            fallback: 'browser_tts'
          });
        }

  } catch (error) {
    console.error('TTS endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      fallback: 'browser_tts'
    });
  }
});

// Edge TTS endpoint - the primary TTS service (no external dependencies)

// Get available voices endpoint
app.get('/api/tts/voices', (req, res) => {
  try {
    const { language } = req.query;
    
    // Return available voices for the specified language with priority for Indian languages
    const voiceList = {
      // Priority 1: Indian Languages (highest accuracy priority)
      'kn': ['kn-IN-SapnaNeural', 'kn-IN-GaganNeural'], // Kannada - optimized for clarity and fluency
      'hi': ['hi-IN-SwaraNeural', 'hi-IN-MadhurNeural'], // Hindi - optimized for natural pronunciation
      'te': ['te-IN-ShrutiNeural', 'te-IN-MohanNeural'], // Telugu - optimized for regional accents
      'ta': ['ta-IN-PallaviNeural', 'ta-IN-ValluvarNeural'], // Tamil - optimized for clarity
      'ml': ['ml-IN-SobhanaNeural', 'ml-IN-MidhunNeural'], // Malayalam - optimized for fluency
      'mr': ['mr-IN-AarohiNeural', 'mr-IN-ManoharNeural'], // Marathi - optimized for natural tone
      
      // International Languages
      'en': ['en-US-AriaNeural', 'en-GB-SoniaNeural', 'en-AU-NatashaNeural', 'en-CA-ClaraNeural'],
      'es': ['es-ES-ElviraNeural', 'es-MX-DaliaNeural', 'es-AR-ElenaNeural'],
      'fr': ['fr-FR-DeniseNeural', 'fr-CA-SylvieNeural'],
      'de': ['de-DE-KatjaNeural'],
      'it': ['it-IT-ElsaNeural'],
      'pt': ['pt-BR-FranciscaNeural', 'pt-PT-RaquelNeural'],
      'ja': ['ja-JP-NanamiNeural'],
      'zh': ['zh-CN-XiaoxiaoNeural', 'zh-TW-HsiaoyuNeural'],
      'ko': ['ko-KR-SunHiNeural'],
      'ar': ['ar-SA-ZariyahNeural'],
      'ru': ['ru-RU-SvetlanaNeural']
    };

    if (language && voiceList[language]) {
      res.json({
        success: true,
        voices: voiceList[language],
        language: language
      });
    } else {
      res.json({
        success: true,
        voices: voiceList['en'], // Default to English
        language: 'en',
        allLanguages: Object.keys(voiceList)
      });
    }
  } catch (error) {
    console.error('Voices endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get voices'
    });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Clara AI Reception System running on port ${PORT}`);
  console.log(`📱 Client Interface: http://localhost:${PORT}`);
  console.log(`👥 Staff Interface: http://localhost:${PORT}/staff-interface`);
  console.log(`🎥 Video Call: Integrated into main interfaces`);
  console.log(`🎓 College Demo: http://localhost:${PORT}/college-demo`);
  console.log(`🔗 n8n Test Page: http://localhost:${PORT}/n8n-test`);
  console.log(`🧪 Route Test Page: http://localhost:${PORT}/test-routes`);
  console.log(`🔧 API health check: http://localhost:${PORT}/api/health`);
  console.log(`🏫 College AI API: http://localhost:${PORT}/api/college/ask`);
  console.log(`🔗 n8n Integration API: http://localhost:${PORT}/api/n8n`);
  console.log(`🧪 n8n Test endpoint: http://localhost:${PORT}/api/n8n/test`);
  console.log(`📱 QR Code Test: http://localhost:${PORT}/api/qr/test`);
  console.log(`🔧 QR Code API: http://localhost:${PORT}/api/qr/generate`);
  
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  
  if (GEMINI_KEY && GEMINI_KEY !== 'your_gemini_api_key_here') {
    console.log(`🤖 Full AI mode enabled with Gemini AI`);
  } else {
    console.log(`⚠️  Note: Running in demo mode. Set GEMINI_API_KEY in .env for full AI functionality.`);
  }
});

module.exports = app;