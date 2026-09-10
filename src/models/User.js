import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
 
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    passwordHash: {
      type: String,
      select: false, // Don't return password by default
    },
    role: {
      type: String,
      enum: ['rep', 'manager', 'admin'],
      default: 'rep',
    },
    salesforceUserId: String,
    salesforceAccessToken: String, // Will be encrypted
    salesforceRefreshToken: String, // Will be encrypted
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);
 
// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) {
    return next();
  }
 
  try {
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (err) {
    next(err);
  }
});
 
// Method to verify password
userSchema.methods.verifyPassword = async function (password) {
  return await bcrypt.compare(password, this.passwordHash);
};
 
// Method to exclude sensitive fields in JSON response
userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.passwordHash;
  delete user.salesforceAccessToken;
  delete user.salesforceRefreshToken;
  return user;
};
 
const User = mongoose.model('User', userSchema);
 
export default User;