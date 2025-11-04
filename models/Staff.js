const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  username: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  department: {
    type: String,
    required: true,
    enum: ['Computer Science', 'Mechanical', 'Civil', 'ECE', 'ISE', 'Administration', 'Support']
  },
  designation: {
    type: String,
    required: true,
    enum: ['Professor', 'Associate Professor', 'Assistant Professor', 'Lecturer', 'HOD', 'Principal', 'Admin Staff', 'Support Staff']
  },
  employeeId: {
    type: String,
    required: true,
    unique: true
  },
  phone: {
    type: String,
    required: true
  },
  office: {
    building: String,
    room: String,
    floor: String
  },
  isAvailable: {
    type: Boolean,
    default: true
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastActive: {
    type: Date,
    default: Date.now
  },
  profileImage: {
    type: String,
    default: null
  },
  specializations: [{
    type: String,
    trim: true
  }],
  qualifications: [{
    degree: String,
    institution: String,
    year: Number
  }],
  experience: {
    years: Number,
    description: String
  },
  workingHours: {
    start: {
      type: String,
      default: '09:00'
    },
    end: {
      type: String,
      default: '17:00'
    }
  },
  breakTime: {
    start: {
      type: String,
      default: '12:00'
    },
    end: {
      type: String,
      default: '13:00'
    }
  },
  isAvailableForCalls: {
    type: Boolean,
    default: true
  },
  maxCallsPerDay: {
    type: Number,
    default: 10
  },
  currentCallsToday: {
    type: Number,
    default: 0
  },
  resetDate: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
staffSchema.index({ name: 'text', department: 1, designation: 1 });
staffSchema.index({ isAvailable: 1, isOnline: 1 });
staffSchema.index({ employeeId: 1 });
staffSchema.index({ username: 1 });

// Method to check if staff is available for calls
staffSchema.methods.canAcceptCall = function() {
  const today = new Date();
  const resetDate = new Date(this.resetDate);
  
  // Reset call count if it's a new day
  if (today.toDateString() !== resetDate.toDateString()) {
    this.currentCallsToday = 0;
    this.resetDate = today;
  }
  
  return this.isAvailable && 
         this.isOnline && 
         this.isAvailableForCalls && 
         this.currentCallsToday < this.maxCallsPerDay;
};

// Method to increment call count
staffSchema.methods.incrementCallCount = function() {
  this.currentCallsToday += 1;
  return this.save();
};

// Method to get availability status
staffSchema.methods.getAvailabilityStatus = function() {
  if (!this.isAvailable) return 'Unavailable';
  if (!this.isOnline) return 'Offline';
  if (!this.isAvailableForCalls) return 'Not accepting calls';
  if (this.currentCallsToday >= this.maxCallsPerDay) return 'Maximum calls reached';
  return 'Available';
};

module.exports = mongoose.model('Staff', staffSchema);
