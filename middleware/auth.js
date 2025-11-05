const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Staff = require('../models/Staff');

/**
 * Middleware to authenticate JWT tokens (Staff only)
 */
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'demo_secret');

    // Check if database is connected
    if (mongoose.connection.readyState === 1) {
      // Find Staff member
      const principal = await Staff.findById(decoded.userId);

      if (!principal) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      req.user = principal;
    } else {
      // Demo mode: attach a minimal principal
      req.user = { _id: decoded.userId, role: 'staff', name: 'Demo Staff' };
    }

    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

module.exports = {
  authenticateToken
};
