    const mongoose = require('mongoose');

const staffCallLogSchema = new mongoose.Schema({
  staffEmail: { type: String, index: true, required: true },
  staffUsername: { type: String, index: true },
  type: { type: String, enum: ['incoming', 'outgoing'], required: true },
  caller: { type: String },
  callee: { type: String },
  timestamp: { type: Date, default: Date.now },
  duration: { type: Number, default: 0 }, // seconds
  status: { type: String, enum: ['completed', 'missed', 'rejected', 'in-progress'], default: 'in-progress' },
  callId: { type: String },
  metadata: { type: Object }
}, { timestamps: true });

staffCallLogSchema.index({ staffEmail: 1, createdAt: -1 });

module.exports = mongoose.model('StaffCallLog', staffCallLogSchema);
