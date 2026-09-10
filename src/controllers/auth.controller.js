import User from '../models/User.js';
import { generateToken, setTokenCookie, clearTokenCookie } from '../services/tokenService.js';
import { AppError } from '../middleware/errorHandler.js';

// Signup: Create new user
export const signup = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    // Validation (backend always validates, even if frontend did)
    if (!name || !email || !password) {
      return next(new AppError('Name, email, and password are required', 400));
    }

    if (password.length < 8) {
      return next(new AppError('Password must be at least 8 characters', 400));
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return next(new AppError('Email already registered', 409));
    }

    // Create user
    const user = new User({
      name,
      email: email.toLowerCase(),
      passwordHash: password,
      role: 'rep',  // Default role for new users
    });

    await user.save();

    // Generate token and set cookie
    const token = generateToken(user._id, user.email, user.role);
    setTokenCookie(res, token);

    res.status(201).json({
      status: 'ok',
      data: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
};

// Login: Verify credentials and create session
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return next(new AppError('Email and password are required', 400));
    }

    // Find user (include password field for comparison)
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');

    if (!user) {
      return next(new AppError('Invalid email or password', 401));
    }

    // Verify password
    const isPasswordValid = await user.verifyPassword(password);
    if (!isPasswordValid) {
      return next(new AppError('Invalid email or password', 401));
    }

    // Generate token and set cookie
    const token = generateToken(user._id, user.email, user.role);
    setTokenCookie(res, token);

    res.status(200).json({
      status: 'ok',
      data: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
};

// Logout: Clear session
export const logout = async (req, res, next) => {
  try {
    clearTokenCookie(res);
    res.status(200).json({
      status: 'ok',
      message: 'Logged out successfully',
    });
  } catch (err) {
    next(err);
  }
};

// Get current user
export const getMe = async (req, res, next) => {
  try {
    // req.user set by protect middleware
    const user = await User.findById(req.user._id);

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    res.status(200).json({
      status: 'ok',
      data: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
};