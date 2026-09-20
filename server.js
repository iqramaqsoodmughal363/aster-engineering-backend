const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const { isAdminEmail } = require('./config/adminEmails');
require('dotenv').config();

const app = express();

// Body Parser Middleware
app.use(express.json());

// Root route for API status check
app.get('/', (req, res) => {
  res.status(200).json({ message: 'Master Engineering API is running successfully!' });
});

// Clean & Robust CORS Configuration for Vercel Serverless
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// MongoDB Connection with Serverless Caching
let isConnected = false;
const connectDB = async () => {
  if (isConnected) return;
  try {
    const db = await mongoose.connect(process.env.MONGO_URI);
    isConnected = db.connections[0].readyState;
    console.log('✅ MongoDB Connected Successfully!');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err);
  }
};
connectDB();

// 1. User Schema & Routes
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  resetPasswordToken: { type: String },
  resetPasswordExpire: { type: Date },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const authenticateUser = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Please sign in to continue.' });
    }
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'User account not found.' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
  }
};

const requireCustomer = (req, res, next) => {
  if (isAdminEmail(req.user.email) || req.user.role === 'admin') {
    return res.status(403).json({ message: 'Admins cannot use the customer cart or place customer orders.' });
  }
  next();
};

app.post('/api/register', async (req, res) => {
  try {
    await connectDB();
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Sabhi fields zaroori hain!' });
    }
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Yeh email pehle se registered hai!' });
    }
    
    // Assign admin role if email matches list
    const normalizedEmail = email.trim().toLowerCase();
    const role = isAdminEmail(normalizedEmail) ? 'admin' : 'user';

    const newUser = new User({ 
      name, 
      email: normalizedEmail,
      password, 
      role 
    });
    await newUser.save();
    res.status(201).json({ message: 'Account successfully ban gaya!' });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    await connectDB();
    const { email, password } = req.body;
    const user = await User.findOne({ email, password });
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password.' });
    }
    
    // Force admin role for authorized emails
    const role = isAdminEmail(user.email) ? 'admin' : (user.role || 'user');

    res.status(200).json({ 
      message: 'Login successful!', 
      user: { id: user._id, name: user.name, email: user.email, role },
      token: jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' })
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
});

const cartSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  items: [{
    productId: { type: String, required: true },
    title: { type: String, required: true },
    thumbnail: String,
    category: String,
    quantity: { type: Number, default: 1, min: 1 },
  }],
}, { timestamps: true });
const Cart = mongoose.models.Cart || mongoose.model('Cart', cartSchema);

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [{
    productId: String,
    title: String,
    thumbnail: String,
    quantity: Number,
  }],
  customer: {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
  },
  status: { type: String, enum: ['Pending', 'Confirmed', 'In Progress', 'Completed'], default: 'Pending' },
}, { timestamps: true });
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

app.get('/api/cart', authenticateUser, requireCustomer, async (req, res) => {
  try {
    await connectDB();
    const cart = await Cart.findOne({ user: req.user._id });
    res.json(cart || { items: [] });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load your cart.' });
  }
});

app.post('/api/cart/items', authenticateUser, requireCustomer, async (req, res) => {
  try {
    await connectDB();
    const { productId, title, thumbnail, category } = req.body;
    if (!productId || !title) return res.status(400).json({ message: 'Product information is required.' });
    let cart = await Cart.findOne({ user: req.user._id });
    if (!cart) cart = new Cart({ user: req.user._id, items: [] });
    const existing = cart.items.find((item) => item.productId === String(productId));
    if (existing) existing.quantity += 1;
    else cart.items.push({ productId: String(productId), title, thumbnail, category, quantity: 1 });
    await cart.save();
    res.status(201).json(cart);
  } catch (error) {
    res.status(500).json({ message: 'Unable to add this item to your cart.' });
  }
});

app.patch('/api/cart/items/:productId', authenticateUser, requireCustomer, async (req, res) => {
  try {
    await connectDB();
    const quantity = Number(req.body.quantity);
    const cart = await Cart.findOne({ user: req.user._id });
    if (!cart) return res.status(404).json({ message: 'Cart not found.' });
    const item = cart.items.find((entry) => entry.productId === req.params.productId);
    if (!item) return res.status(404).json({ message: 'Cart item not found.' });
    if (!Number.isInteger(quantity) || quantity < 1) cart.items = cart.items.filter((entry) => entry.productId !== req.params.productId);
    else item.quantity = quantity;
    await cart.save();
    res.json(cart);
  } catch (error) {
    res.status(500).json({ message: 'Unable to update your cart.' });
  }
});

app.post('/api/orders', authenticateUser, requireCustomer, async (req, res) => {
  try {
    await connectDB();
    const { items, customer } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'Your cart is empty.' });
    if (!customer?.name || !customer?.phone || !customer?.address) return res.status(400).json({ message: 'Please complete your delivery details.' });
    const order = await Order.create({ user: req.user._id, items, customer });
    await Cart.findOneAndUpdate({ user: req.user._id }, { items: [] });
    res.status(201).json({ message: 'Order placed successfully.', order });
  } catch (error) {
    res.status(500).json({ message: 'Unable to place your order.' });
  }
});

app.get('/api/orders/my', authenticateUser, requireCustomer, async (req, res) => {
  try {
    await connectDB();
    res.json(await Order.find({ user: req.user._id }).sort({ createdAt: -1 }));
  } catch (error) {
    res.status(500).json({ message: 'Unable to load your orders.' });
  }
});

app.delete('/api/orders/:orderId', authenticateUser, requireCustomer, async (req, res) => {
  try {
    await connectDB();
    const order = await Order.findOne({ _id: req.params.orderId, user: req.user._id });
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (order.status !== 'Pending') return res.status(400).json({ message: 'Only pending orders can be cancelled.' });
    await order.deleteOne();
    res.json({ message: 'Order cancelled successfully.' });
  } catch (error) {
    res.status(500).json({ message: 'Unable to cancel this order.' });
  }
});

app.get('/api/orders', authenticateUser, async (req, res) => {
  try {
    await connectDB();
    if (!isAdminEmail(req.user.email) && req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access is required.' });
    res.json(await Order.find().populate('user', 'name email').sort({ createdAt: -1 }));
  } catch (error) {
    res.status(500).json({ message: 'Unable to load orders.' });
  }
});

app.patch('/api/orders/:orderId/status', authenticateUser, async (req, res) => {
  try {
    await connectDB();
    if (!isAdminEmail(req.user.email) && req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access is required.' });
    const allowedStatuses = ['Pending', 'Confirmed', 'In Progress', 'Completed'];
    if (!allowedStatuses.includes(req.body.status)) return res.status(400).json({ message: 'Invalid order status.' });
    const order = await Order.findByIdAndUpdate(req.params.orderId, { status: req.body.status }, { new: true }).populate('user', 'name email');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    res.json({ message: 'Order status updated successfully.', order });
  } catch (error) {
    res.status(500).json({ message: 'Unable to update order status.' });
  }
});

app.get('/api/admin/carts', authenticateUser, async (req, res) => {
  try {
    await connectDB();
    if (!isAdminEmail(req.user.email) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access is required.' });
    }
    res.json(await Cart.find({ 'items.0': { $exists: true } }).populate('user', 'name email').sort({ updatedAt: -1 }));
  } catch (error) {
    res.status(500).json({ message: 'Unable to load customer carts.' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    await connectDB();
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Please provide an email address.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'No account was found for this email address.' });
    }
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(500).json({ message: 'Password reset email is not configured.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpire = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    const frontendUrl = process.env.FRONTEND_URL || 'https://master-engineering-frontend.vercel.app';
    const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: 'Password Reset - Master Engineering',
      text: `Reset your password using this link. It expires in 10 minutes: ${resetUrl}`
    });

    res.status(200).json({ message: 'Password reset link sent to your email.' });
  } catch (error) {
    console.error('Forgot Password Error:', error);
    res.status(500).json({ message: 'Unable to send the password reset email.' });
  }
});

app.put('/api/auth/reset-password/:token', async (req, res) => {
  try {
    await connectDB();
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    const hashedToken = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: new Date() }
    });
    if (!user) {
      return res.status(400).json({ message: 'This password reset link is invalid or has expired.' });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    res.status(200).json({ message: 'Password reset successful. You can now sign in.' });
  } catch (error) {
    console.error('Reset Password Error:', error);
    res.status(500).json({ message: 'Unable to reset the password.' });
  }
});

// 2. Gallery / Projects Schema & Routes (Unified)
const gallerySchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageUrl: { type: String, required: true },
  description: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const Gallery = mongoose.models.Gallery || mongoose.model('Gallery', gallerySchema);

// Handle POST to /api/projects or /api/gallery
const handleAddGalleryItem = async (req, res) => {
  try {
    await connectDB();
    const { title, imageUrl, description } = req.body;
    if (!title || !imageUrl) {
      return res.status(400).json({ message: 'Title and Image URL are required!' });
    }
    const newItem = new Gallery({ title, imageUrl, description });
    await newItem.save();
    res.status(201).json({ message: 'Item added to gallery successfully!', newItem });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

app.post('/api/projects', handleAddGalleryItem);
app.post('/api/gallery', handleAddGalleryItem);

// Handle GET to /api/projects and /api/gallery
const handleGetGalleryItems = async (req, res) => {
  try {
    await connectDB();
    const items = await Gallery.find().sort({ createdAt: -1 });
    res.status(200).json(items);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

app.get('/api/projects', handleGetGalleryItems);
app.get('/api/gallery', handleGetGalleryItems);

// 3. Services Schema & Routes
const serviceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  icon: { type: String },
  description: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Service = mongoose.models.Service || mongoose.model('Service', serviceSchema);

app.post('/api/services', async (req, res) => {
  try {
    await connectDB();
    const { title, icon, description } = req.body;
    if (!title || !description) {
      return res.status(400).json({ message: 'Title and description are required!' });
    }
    const newService = new Service({ title, icon, description });
    await newService.save();
    res.status(201).json({ message: 'Service added successfully!', newService });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
});

app.get('/api/services', async (req, res) => {
  try {
    await connectDB();
    const services = await Service.find().sort({ createdAt: -1 });
    res.status(200).json(services);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
module.exports = app;