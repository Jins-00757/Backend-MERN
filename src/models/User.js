import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * User Schema - Production Grade
 * Includes authentication, role-based access, and Salesforce integration
 */

const userSchema = new mongoose.Schema(
  {
    // ========================================================================
    // CORE AUTHENTICATION FIELDS
    // ========================================================================
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name must not exceed 100 characters'],
      index: true,
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email',
      ],
      index: true,
    },

    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false, // Don't return password by default
    },

    role: {
      type: String,
      enum: {
        values: ['user', 'admin', 'manager'],
        message: 'Role must be one of: user, admin, manager',
      },
      default: 'user',
      index: true,
    },

    // ========================================================================
    // ACCOUNT STATUS
    // ========================================================================
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    emailVerificationToken: {
      type: String,
      select: false,
    },

    emailVerificationExpiry: {
      type: Date,
      select: false,
    },

    // ========================================================================
    // PASSWORD RESET
    // ========================================================================
    passwordResetToken: {
      type: String,
      select: false,
    },

    passwordResetExpiry: {
      type: Date,
      select: false,
    },

    lastPasswordChange: {
      type: Date,
      default: Date.now,
    },

    // ========================================================================
    // SALESFORCE INTEGRATION (Day 3)
    // ========================================================================
    salesforceUserId: {
      type: String,
      sparse: true,
      index: true,
    },

    salesforceInstanceUrl: {
      type: String,
      sparse: true,
    },

    salesforceAccessToken: {
      type: String,
      sparse: true,
      select: false, // Encrypted, not returned by default
    },

    salesforceRefreshToken: {
      type: String,
      sparse: true,
      select: false, // Encrypted, not returned by default
    },

    salesforceTokenExpiry: {
      type: Date,
      sparse: true,
    },

    salesforceConnectedAt: {
      type: Date,
      sparse: true,
    },

    salesforceOrgName: {
      type: String,
      sparse: true,
    },

    lastSalesforceSync: {
      type: Date,
      sparse: true,
    },

    // ========================================================================
    // USER PROFILE
    // ========================================================================
    phoneNumber: {
      type: String,
      sparse: true,
      trim: true,
    },

    company: {
      type: String,
      sparse: true,
      trim: true,
    },

    jobTitle: {
      type: String,
      sparse: true,
      trim: true,
    },

    profilePicture: {
      type: String,
      sparse: true,
    },

    bio: {
      type: String,
      maxlength: [500, 'Bio must not exceed 500 characters'],
      sparse: true,
    },

    // ========================================================================
    // PREFERENCES
    // ========================================================================
    preferences: {
      emailNotifications: {
        type: Boolean,
        default: true,
      },
      smsNotifications: {
        type: Boolean,
        default: false,
      },
      theme: {
        type: String,
        enum: ['light', 'dark', 'auto'],
        default: 'auto',
      },
      language: {
        type: String,
        enum: ['en', 'es', 'fr', 'de', 'pt'],
        default: 'en',
      },
    },

    // ========================================================================
    // SECURITY & AUDIT
    // ========================================================================
    loginAttempts: {
      type: Number,
      default: 0,
      select: false,
    },

    lockUntil: {
      type: Date,
      select: false,
    },

    lastLogin: {
      type: Date,
      sparse: true,
    },

    lastLoginIP: {
      type: String,
      sparse: true,
      select: false,
    },

    loginHistory: [
      {
        timestamp: Date,
        ipAddress: String,
        userAgent: String,
        success: Boolean,
      },
    ],

    // ========================================================================
    // SUBSCRIPTIONS & BILLING (Future)
    // ========================================================================
    subscription: {
      plan: {
        type: String,
        enum: ['free', 'pro', 'enterprise'],
        default: 'free',
      },
      startDate: Date,
      endDate: Date,
      isActive: Boolean,
      autoRenew: {
        type: Boolean,
        default: true,
      },
    },

    // ========================================================================
    // TIMESTAMPS
    // ========================================================================
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
  }
);

// ============================================================================
// INDEXES - For Performance
// ============================================================================

userSchema.index({ email: 1 }); // Email lookup
userSchema.index({ salesforceUserId: 1 }); // Salesforce lookup
userSchema.index({ isActive: 1, createdAt: -1 }); // Active users list
userSchema.index({ role: 1 }); // Role-based queries
userSchema.index({ 'subscription.isActive': 1 }); // Subscription lookup

// ============================================================================
// VIRTUALS
// ============================================================================

/**
 * Virtual for account age in days
 */
userSchema.virtual('accountAgeDays').get(function () {
  const now = new Date();
  const createdAt = new Date(this.createdAt);
  const ageMs = now - createdAt;
  return Math.floor(ageMs / (1000 * 60 * 60 * 24));
});

/**
 * Virtual for Salesforce connected status
 */
userSchema.virtual('isSalesforceConnected').get(function () {
  return !!this.salesforceUserId;
});

/**
 * Virtual for account locked status
 */
userSchema.virtual('isAccountLocked').get(function () {
  return this.lockUntil && this.lockUntil > new Date();
});

// ============================================================================
// INSTANCE METHODS
// ============================================================================

/**
 * Compare password with hashed password
 * @param {string} password - Plain text password to compare
 * @returns {Promise<boolean>} - True if passwords match
 */
userSchema.methods.comparePassword = async function (password) {
  try {
    return await bcrypt.compare(password, this.passwordHash);
  } catch (error) {
    console.error('❌ Password comparison error:', error.message);
    throw error;
  }
};

/**
 * Hash password before saving
 * @param {string} password - Plain text password to hash
 * @returns {Promise<void>}
 */
userSchema.methods.hashPassword = async function (password) {
  try {
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(password, salt);
  } catch (error) {
    console.error('❌ Password hashing error:', error.message);
    throw error;
  }
};

/**
 * Record failed login attempt
 * @returns {Promise<void>}
 */
userSchema.methods.recordFailedLogin = async function () {
  try {
    this.loginAttempts = (this.loginAttempts || 0) + 1;

    // Lock account after 5 failed attempts for 30 minutes
    if (this.loginAttempts >= 5) {
      this.lockUntil = new Date(Date.now() + 30 * 60 * 1000);
      console.warn(`⚠️  Account locked for user: ${this.email}`);
    }

    await this.save();
  } catch (error) {
    console.error('❌ Error recording failed login:', error.message);
  }
};

/**
 * Record successful login
 * @param {string} ipAddress - User's IP address
 * @param {string} userAgent - User's browser user agent
 * @returns {Promise<void>}
 */
userSchema.methods.recordSuccessfulLogin = async function (ipAddress, userAgent) {
  try {
    this.loginAttempts = 0;
    this.lockUntil = null;
    this.lastLogin = new Date();
    this.lastLoginIP = ipAddress;

    // Keep last 10 login records
    this.loginHistory = (this.loginHistory || []).slice(-9);
    this.loginHistory.push({
      timestamp: new Date(),
      ipAddress,
      userAgent,
      success: true,
    });

    await this.save();
  } catch (error) {
    console.error('❌ Error recording successful login:', error.message);
  }
};

/**
 * Check if account is locked
 * @returns {boolean}
 */
userSchema.methods.checkAccountLock = function () {
  return this.lockUntil && this.lockUntil > new Date();
};

/**
 * Reset password
 * @param {string} newPassword - New password to set
 * @returns {Promise<void>}
 */
userSchema.methods.resetPassword = async function (newPassword) {
  try {
    await this.hashPassword(newPassword);
    this.passwordResetToken = null;
    this.passwordResetExpiry = null;
    this.lastPasswordChange = new Date();
    await this.save();
  } catch (error) {
    console.error('❌ Error resetting password:', error.message);
    throw error;
  }
};

/**
 * Get user data for API response (without sensitive fields)
 * @returns {Object}
 */
userSchema.methods.toJSON = function () {
  const user = this.toObject();

  // Remove sensitive fields
  delete user.passwordHash;
  delete user.salesforceAccessToken;
  delete user.salesforceRefreshToken;
  delete user.passwordResetToken;
  delete user.emailVerificationToken;
  delete user.loginAttempts;
  delete user.lockUntil;
  delete user.lastLoginIP;
  delete user.loginHistory;

  return user;
};

// ============================================================================
// STATIC METHODS
// ============================================================================

/**
 * Find user by email
 * @param {string} email - User's email
 * @returns {Promise<Object>} - User document
 */
userSchema.statics.findByEmail = function (email) {
  return this.findOne({ email: email.toLowerCase() });
};

/**
 * Find user by Salesforce ID
 * @param {string} salesforceUserId - Salesforce user ID
 * @returns {Promise<Object>} - User document
 */
userSchema.statics.findBySalesforceId = function (salesforceUserId) {
  return this.findOne({ salesforceUserId });
};

/**
 * Find users by role
 * @param {string} role - User role
 * @returns {Promise<Array>} - Array of users
 */
userSchema.statics.findByRole = function (role) {
  return this.find({ role, isActive: true });
};

/**
 * Get active users count
 * @returns {Promise<number>}
 */
userSchema.statics.getActiveUsersCount = function () {
  return this.countDocuments({ isActive: true });
};

/**
 * Get Salesforce connected users
 * @returns {Promise<Array>}
 */
userSchema.statics.getSalesforceConnectedUsers = function () {
  return this.find({ salesforceUserId: { $exists: true, $ne: null } });
};

// ============================================================================
// PRE-SAVE MIDDLEWARE
// ============================================================================

/**
 * Hash password before saving if modified
 */
userSchema.pre('save', async function (next) {
  try {
    // Only hash password if it has been modified or is new
    if (!this.isModified('passwordHash')) {
      return next();
    }

    // Check if passwordHash is already hashed (starts with $2a$ or $2b$)
    if (this.passwordHash.startsWith('$2a$') || this.passwordHash.startsWith('$2b$')) {
      return next();
    }

    // Hash the password
    await this.hashPassword(this.passwordHash);
    next();
  } catch (error) {
    console.error('❌ Error in pre-save middleware:', error.message);
    next(error);
  }
});

/**
 * Remove login history for deleted users
 */
userSchema.pre('deleteOne', async function (next) {
  try {
    const user = await this.model.findOne(this.getFilter());
    if (user) {
      user.loginHistory = [];
      user.loginAttempts = 0;
      user.lockUntil = null;
      await user.save();
    }
    next();
  } catch (error) {
    console.error('❌ Error in pre-delete middleware:', error.message);
    next(error);
  }
});

// ============================================================================
// POST-SAVE MIDDLEWARE
// ============================================================================

/**
 * Log user creation
 */
userSchema.post('save', function (doc) {
  if (this.isNew) {
    console.log(`✅ New user created: ${doc.email} (ID: ${doc._id})`);
  }
});

// ============================================================================
// MODEL EXPORT
// ============================================================================

export default mongoose.model('User', userSchema);