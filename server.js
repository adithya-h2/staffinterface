const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION - server will exit');
  console.error(err && err.stack ? err.stack : err);
  try { setTimeout(() => process.exit(1), 250); } catch (_) { process.exit(1); }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION - server will exit');
  console.error('Reason:', reason);
  try { setTimeout(() => process.exit(1), 250); } catch (_) { process.exit(1); }
});

// Import models (staff-only)
const Staff = require('./models/Staff');
const StaffTimetable = require('./models/StaffTimetable');
const Call = require('./models/Call');
const StaffCallLog = require('./models/StaffCallLog');
const { getStaffCallLogModel } = require('./services/staffCollections');

// Import staff portal routes
const staffPortalRoutes = require('./routes/staffPortal');

// Import staff profiles for demo support
const staffProfiles = require('./staff-profiles.js');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Static middleware
app.use(express.static(path.join(__dirname, 'public')));

// Helper to check DB connectivity
const isDbConnected = () => mongoose.connection.readyState === 1;

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/clara_ai';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Socket.IO State Management (Staff only)
const staffSessions = new Map(); // staffId -> socketId
const staffEmailSessions = new Map(); // email -> socketId
const connectedUsers = new Map(); // socketId -> { name, email, type }
const activeCalls = new Map(); // callId -> { staffSocketId, clientSocketId, startTime }

// API Routes - Staff portal only
app.use('/api/staff', staffPortalRoutes);

// Staff interface routes
app.get('/', (req, res) => {
  res.redirect('/staff-interface');
});

app.get('/staff', (req, res) => {
  res.redirect('/staff-interface');
});

app.get('/staff-interface', (req, res) => {
  res.sendFile(__dirname + '/public/staff-interface.html');
});

app.get('/staff-interface/:username', (req, res) => {
  res.sendFile(__dirname + '/public/staff-interface.html');
});

// Health check
app.get('/api/health', async (req, res) => {
  const dbStatus = isDbConnected() ? 'connected' : 'disconnected';
  res.json({
    status: 'ok',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Favicon
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Socket.IO - Staff Only
io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);

  // Register staff by email
  socket.on('register-staff', (staffEmail) => {
    try {
      staffEmailSessions.set(staffEmail, socket.id);
      connectedUsers.set(socket.id, { email: staffEmail, type: 'staff' });
      console.log(`📧 Staff registered with email: ${staffEmail}`);
      socket.emit('staff-registered', { email: staffEmail, success: true });
    } catch (error) {
      console.error('Error registering staff:', error);
      socket.emit('staff-registration-error', { message: 'Failed to register staff' });
    }
  });

  // Handle incoming video call from client (staff accepts)
  socket.on('call-accepted', async (data) => {
    console.log('📞 Staff accepted call:', data);
    const { requestId, staffEmail, staffName } = data;
    
    // Create call session
    const callId = `call_${Date.now()}_${uuidv4()}`;
    
    // Store call info
    activeCalls.set(callId, {
      staffSocketId: socket.id,
      staffEmail,
      staffName,
      startTime: new Date()
    });

    // Notify client that staff accepted
    socket.broadcast.emit('call-accepted-by-staff', {
      callId,
      staffName,
      requestId
    });

    // Tell staff to start call
    socket.emit('start-call', {
      callId,
      clientName: 'Client'
    });
  });

  // Handle call rejection
  socket.on('call-rejected', (data) => {
    console.log('❌ Staff rejected call:', data);
    socket.broadcast.emit('call-rejected-by-staff', data);
  });

  // Handle call end
  socket.on('end-call', async ({ callId, reason }) => {
    console.log('📞 Call ended:', callId, reason);
    
    const callSession = activeCalls.get(callId);
    if (!callSession) return;

    const duration = callSession.startTime ? Math.floor((new Date() - callSession.startTime) / 1000) : 0;

    // Persist staff call log
    try {
      if (isDbConnected() && callSession.staffEmail) {
        const staffEmail = callSession.staffEmail;
        const username = (staffEmail.split('@')[0] || '').toLowerCase();
        
        // Write to global call log
        await StaffCallLog.findOneAndUpdate(
          { callId, staffEmail },
          {
            $setOnInsert: {
              type: 'incoming',
              caller: 'Client',
              callee: callSession.staffName || 'Staff',
              timestamp: callSession.startTime || new Date(),
              staffUsername: username
            },
            $set: {
              status: 'completed',
              duration: duration,
              metadata: { reason: reason || 'ended' }
            }
          },
          { upsert: true, new: true }
        );

        // Write to per-staff collection
        try {
          const CL = getStaffCallLogModel(username);
          await CL.findOneAndUpdate(
            { callId, staffEmail },
            {
              $setOnInsert: {
                type: 'incoming',
                caller: 'Client',
                callee: callSession.staffName || 'Staff',
                timestamp: callSession.startTime || new Date(),
                staffUsername: username
              },
              $set: {
                status: 'completed',
                duration: duration,
                metadata: { reason: reason || 'ended' }
              }
            },
            { upsert: true, new: true }
          );
        } catch (_) {}
      }
    } catch (logErr) {
      console.error('Failed to write StaffCallLog:', logErr.message);
    }

    // Clean up
    activeCalls.delete(callId);
    
    // Notify both parties
    socket.emit('call-ended', { callId, reason });
    socket.broadcast.emit('call-ended', { callId, reason });
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    socket.broadcast.emit('offer', data);
  });

  socket.on('answer', (data) => {
    socket.broadcast.emit('answer', data);
  });

  socket.on('ice-candidate', (data) => {
    socket.broadcast.emit('ice-candidate', data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('👋 User disconnected:', socket.id);
    
    // Clean up staff sessions
    const user = connectedUsers.get(socket.id);
    if (user && user.email) {
      staffEmailSessions.delete(user.email);
    }
    connectedUsers.delete(socket.id);
    
    // Clean up any active calls
    for (const [callId, callSession] of activeCalls.entries()) {
      if (callSession.staffSocketId === socket.id) {
        activeCalls.delete(callId);
        socket.broadcast.emit('call-ended', { callId, reason: 'disconnect' });
      }
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log('');
  console.log('🚀 Staff Dashboard Server Running');
  console.log('================================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/api/health`);
  console.log(`👨‍🏫 Staff Interface: http://localhost:${PORT}/staff-interface`);
  console.log('');
  console.log('📋 Demo Staff Accounts:');
  staffProfiles.slice(0, 3).forEach(s => {
    console.log(`   • ${s.name}: ${s.email} / ${s.password}`);
    console.log(`     URL: http://localhost:${PORT}/staff-interface/${s.email.split('@')[0].toLowerCase()}`);
  });
  console.log('');
});
