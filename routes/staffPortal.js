const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const Staff = require('../models/Staff');
// Base models remain for schema reuse, but we'll write/read per-staff collections
const StaffTimetable = require('../models/StaffTimetable');
const StaffCallLog = require('../models/StaffCallLog');
const { getStaffTimetableModel, getStaffCallLogModel, sanitize } = require('../services/staffCollections');
const staffProfiles = require('../staff-profiles');

const router = express.Router();

// POST /api/staff/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Database not connected' });

    let staff = await Staff.findOne({ email: String(email).toLowerCase().trim() });
    if (!staff) {
      // Seed from demo staff-profiles if present
      const profile = staffProfiles.find(p => p.email.toLowerCase() === String(email).toLowerCase());
      if (profile && (password === profile.password)) {
        // Prepare defaults to satisfy Staff schema required fields / enums
        const hashed = await bcrypt.hash(password, 10);
        const allowedDepartments = ['Computer Science','Mechanical','Civil','ECE','ISE','Administration','Support'];
        const normalizedDept = (profile.department || '').toLowerCase().includes('computer') ? 'Computer Science' :
                               (allowedDepartments.includes(profile.department) ? profile.department : 'Administration');
        const designation = profile.name?.includes('Prof.') || profile.name?.includes('Dr.') ? 'Professor' : 'Assistant Professor';
        const username = (profile.email.split('@')[0]).toLowerCase();
        const employeeId = `EMP-${(profile.shortName||username)}-${Math.floor(Math.random()*9000+1000)}`;
        const phone = '0000000000';

        try {
          staff = await Staff.create({
            name: profile.name,
            email: profile.email.toLowerCase(),
            username,
            password: hashed,
            department: normalizedDept,
            designation,
            employeeId,
            phone,
            isAvailable: true,
            isOnline: false
          });
        } catch (createErr) {
          // If unique collisions occur (employeeId/username), retry once with new ids
          try {
            const fallbackId = `EMP-${Date.now()}`;
            const fallbackUser = `${username}${Math.floor(Math.random()*90+10)}`;
            staff = await Staff.create({
              name: profile.name,
              email: profile.email.toLowerCase(),
              username: fallbackUser,
              password: hashed,
              department: normalizedDept,
              designation,
              employeeId: fallbackId,
              phone,
              isAvailable: true,
              isOnline: false
            });
          } catch (e2) {
            console.error('Failed to auto-create Staff from demo profile:', e2.message);
            return res.status(500).json({ error: 'Login failed' });
          }
        }
      } else {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }

    let valid = false;
    try { valid = await bcrypt.compare(password, staff.password); } catch (_) {}
    if (!valid) {
      // fallback for plain text dev accounts
      valid = password === staff.password;
    }
    if (!valid) {
      // Secondary fallback: allow known demo credentials from staff-profiles
      const profile = staffProfiles.find(p => p.email.toLowerCase() === String(email).toLowerCase());
      if (profile && password === profile.password) {
        // ensure username, sync password to hashed version for future logins
        try {
          if (!staff.username) staff.username = (staff.email.split('@')[0]).toLowerCase();
          staff.password = await bcrypt.hash(password, 10);
          await staff.save();
          valid = true;
        } catch (_) {}
      }
    }
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const payload = { userId: staff._id.toString(), role: 'staff' };
    const token = jwt.sign(payload, process.env.JWT_SECRET || 'demo_secret', { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });

    const username = staff.username || (staff.email.split('@')[0]);
    if (!staff.username) {
      try { staff.username = username.toLowerCase(); await staff.save(); } catch (_) {}
    }

    res.json({
      token,
      staff: {
        id: staff._id.toString(),
        name: staff.name,
        email: staff.email,
        department: staff.department,
        username
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/staff/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Database not connected' });
    const staff = await Staff.findById(req.user._id || req.user.userId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    res.json({
      id: staff._id.toString(),
      name: staff.name,
      email: staff.email,
      department: staff.department,
      username: staff.username || (staff.email?.split('@')[0])
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Helper to ensure route staff matches token user
async function ensureSelf(req, res, next) {
  try {
    const usernameParam = String(req.params.username || '').toLowerCase();
    const staff = await Staff.findById(req.user._id || req.user.userId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    const username = (staff.username || staff.email.split('@')[0]).toLowerCase();
    if (username !== usernameParam) return res.status(403).json({ error: 'Forbidden' });
    req._staffDoc = staff;
    req._username = usernameParam;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// Timetable CRUD
router.get('/:username/timetable', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const staffId = req._staffDoc._id.toString();
    const TT = getStaffTimetableModel(req._username);
    const tt = await TT.findOne({ staffId, isActive: true }).sort({ lastUpdated: -1 });
    res.json(tt || { staffId, entries: [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch timetable' });
  }
});

router.post('/:username/timetable', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const staffId = req._staffDoc._id.toString();
    const TT = getStaffTimetableModel(req._username);
    let tt = await TT.findOne({ staffId, isActive: true });
    if (!tt) {
      tt = new TT({ staffId, academicYear: '2024-25', semester: '1st Semester', entries: [] });
    }
    const entry = req.body;
    tt.entries.push(entry);
    tt.lastUpdated = new Date();
    await tt.save();
    res.json({ success: true, timetable: tt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add timetable entry' });
  }
});

router.put('/:username/timetable/:entryId', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const staffId = req._staffDoc._id.toString();
    const TT = getStaffTimetableModel(req._username);
    const tt = await TT.findOne({ staffId, isActive: true });
    if (!tt) return res.status(404).json({ error: 'Timetable not found' });
    const entry = tt.entries.id(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    Object.assign(entry, req.body);
    tt.lastUpdated = new Date();
    await tt.save();
    res.json({ success: true, timetable: tt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update timetable entry' });
  }
});

router.delete('/:username/timetable/:entryId', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const staffId = req._staffDoc._id.toString();
    const TT = getStaffTimetableModel(req._username);
    const tt = await TT.findOne({ staffId, isActive: true });
    if (!tt) return res.status(404).json({ error: 'Timetable not found' });
    const entry = tt.entries.id(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    entry.remove();
    tt.lastUpdated = new Date();
    await tt.save();
    res.json({ success: true, timetable: tt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete timetable entry' });
  }
});

// Bulk save (replace all entries) for Edit/Save UI
router.put('/:username/timetable', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const staffId = req._staffDoc._id.toString();
    const TT = getStaffTimetableModel(req._username);
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    let tt = await TT.findOne({ staffId, isActive: true });
    if (!tt) {
      tt = new TT({ staffId, academicYear: '2024-25', semester: '1st Semester', entries: [] });
    }
    tt.entries = entries;
    tt.lastUpdated = new Date();
    await tt.save();
    res.json({ success: true, timetable: tt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save timetable' });
  }
});

// Call logs
router.get('/:username/call-logs', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const email = req._staffDoc.email;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;
    const CL = getStaffCallLogModel(req._username);
    const [items, total] = await Promise.all([
      CL.find({ staffEmail: email }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      CL.countDocuments({ staffEmail: email })
    ]);
    res.json({ items, page, limit, total });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
});

router.post('/:username/call-logs', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const email = req._staffDoc.email;
    const username = req._staffDoc.username || (email.split('@')[0]);
    const CL = getStaffCallLogModel(req._username);
    const doc = new CL({ ...req.body, staffEmail: email, staffUsername: username });
    await doc.save();
    res.json({ success: true, log: doc });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create call log' });
  }
});

router.patch('/:username/call-logs/:id', authenticateToken, ensureSelf, async (req, res) => {
  try {
    const email = req._staffDoc.email;
    const CL = getStaffCallLogModel(req._username);
    const updated = await CL.findOneAndUpdate({ _id: req.params.id, staffEmail: email }, { $set: req.body }, { new: true });
    if (!updated) return res.status(404).json({ error: 'Log not found' });
    res.json({ success: true, log: updated });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update call log' });
  }
});

module.exports = router;
