import mongoose from 'mongoose';
import bcryptjs from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters'],
    maxlength: [50, 'Name must be at most 50 characters'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Invalid email format'],
  },
  passwordHash: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false,  // IMPORTANT: Never auto-return password
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'rep'],
    default: 'rep',
  },

  // Optional Salesforce connection
  salesforceConnected: {
    type: Boolean,
    default: false,
  },
  salesforceOrgId: String,
  salesforceAccessToken: String,  // Will be encrypted before storage
  salesforceRefreshToken: String, // Will be encrypted before storage
  salesforceUsername: String,

  lastSyncedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  // Only hash if password is new or modified
  if (!this.isModified('passwordHash')) {
    return next();
  }

  try {
    const salt = await bcryptjs.genSalt(12);
    this.passwordHash = await bcryptjs.hash(this.passwordHash, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Method to verify password
userSchema.methods.verifyPassword = async function (candidatePassword) {
  return bcryptjs.compare(candidatePassword, this.passwordHash);
};

// Method to return safe user object (no password)
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.salesforceAccessToken;
  delete obj.salesforceRefreshToken;
  return obj;
};

export default mongoose.model('User', userSchema);