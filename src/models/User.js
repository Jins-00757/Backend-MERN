import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide a name'],
    },
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      match: [
        // Domain suffix is {2,} (not {2,3}) - a {2,3} cap wrongly rejects
        // valid addresses on longer TLDs (.info, .technology, .london, ...).
        /^[\w.+-]+@\w+([.-]?\w+)*(\.\w{2,})+$/,
        'Please provide a valid email address',
      ],
    },
    password: {
      type: String,
      required: [true, 'Please provide a password'],
      minlength: 8,
      select: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin', 'manager'],
      default: 'user',
    },
    company: String,
    jobTitle: String,
    department: String,
    phoneNumber: String,
    bio: String,
    profilePicture: String,
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpiry: {
      type: Date,
      select: false,
    },
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpiry: {
      type: Date,
      select: false,
    },

    // Salesforce OAuth
    salesforceUserId: String,
    salesforceOrgName: String,
    isSalesforceConnected: {
      type: Boolean,
      default: false,
    },
    salesforceAccessToken: String, // Encrypted
    salesforceRefreshToken: String, // Encrypted
    salesforceInstanceUrl: String,
    salesforceTokenExpiresAt: Date,
    salesforceConnectedAt: Date,
    
    // Day 4: Advanced features
    syncPreferences: {
      autoSync: {
        type: Boolean,
        default: true,
      },
      syncInterval: {
        type: Number,
        default: 3600, // 1 hour in seconds
      },
      lastSyncedAt: Date,
      syncStatus: {
        type: String,
        enum: ['idle', 'syncing', 'error'],
        default: 'idle',
      },
    },
    
    dataFilters: {
      defaultOppStage: String,
      defaultOppAmountMin: Number,
      defaultOppAmountMax: Number,
      excludedAccountIds: [String],
      includedAccountIds: [String],
    },

    preferences: {
      theme: {
        type: String,
        enum: ['light', 'dark', 'auto'],
        default: 'auto',
      },
      timezone: {
        type: String,
        default: 'America/Los_Angeles',
      },
      dateFormat: {
        type: String,
        default: 'MM/DD/YYYY',
      },
      notifications: {
        email: Boolean,
        inApp: Boolean,
        sms: Boolean,
      },
    },
    isInactive: {
      type: Boolean,
      default: false,
    },

    // Audit trail
    lastLoginAt: Date,
    lastActivityAt: Date,
    loginCount: {
      type: Number,
      default: 0,
    },

    // Two-Factor Authentication (TOTP)
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    // Encrypted (encryptField/decryptField) - the confirmed, active secret.
    twoFactorSecret: {
      type: String,
      select: false,
    },
    // Encrypted - set by POST /2fa/setup and only promoted to
    // twoFactorSecret once POST /2fa/verify-setup proves the user actually
    // has it loaded in an authenticator app. Never used for login.
    twoFactorPendingSecret: {
      type: String,
      select: false,
    },
    // SHA-256 hashes only (never the raw code) - same hashing pattern as
    // passwordResetToken/emailVerificationToken above.
    backupCodes: {
      type: [
        {
          codeHash: String,
          usedAt: Date,
        },
      ],
      select: false,
      default: undefined,
    },
    lastTotpValidation: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (enteredPassword) {
  // Ensure both parameters exist
  if (!enteredPassword) {
    throw new Error('Password is required');
  }
  
  if (!this.password) {
    throw new Error('User password not set');
  }

  try {
    return await bcrypt.compare(enteredPassword, this.password);
  } catch (error) {
    console.error('bcrypt comparison error:', error);
    throw error;
  }
};

// Set a new password (used by change-password and reset-password flows) and
// clear any outstanding reset token. The pre('save') hook above re-hashes
// `password` whenever it is modified, so this never stores it in plaintext.
userSchema.methods.resetPassword = async function (newPassword) {
  this.password = newPassword;
  this.passwordResetToken = undefined;
  this.passwordResetExpiry = undefined;
  await this.save();
  return this;
};

// Remove sensitive fields from JSON
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.salesforceAccessToken;
  delete obj.salesforceRefreshToken;
  delete obj.twoFactorSecret;
  delete obj.twoFactorPendingSecret;
  delete obj.backupCodes;
  return obj;
};

export default mongoose.model('User', userSchema);