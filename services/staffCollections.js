const mongoose = require('mongoose');
const StaffTimetable = require('../models/StaffTimetable');
const StaffCallLog = require('../models/StaffCallLog');

// Sanitize username for collection names
function sanitize(u) {
  return String(u || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
}

function getStaffTimetableModel(username) {
  const key = `TTModel_${sanitize(username)}`;
  const collection = `timetable_${sanitize(username)}`;
  if (mongoose.models[key]) return mongoose.models[key];
  // Reuse the same schema but different collection per staff
  return mongoose.model(key, StaffTimetable.schema, collection);
}

function getStaffCallLogModel(username) {
  const key = `CLModel_${sanitize(username)}`;
  const collection = `calllog_${sanitize(username)}`;
  if (mongoose.models[key]) return mongoose.models[key];
  return mongoose.model(key, StaffCallLog.schema, collection);
}

module.exports = {
  getStaffTimetableModel,
  getStaffCallLogModel,
  sanitize
};
