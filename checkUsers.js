const mongoose = require('mongoose');
require('dotenv').config();

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  createdAt: Date
});

const User = mongoose.model('User', userSchema);

async function showUsers() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('\n====================================');
    console.log('       REGISTERED USERS LIST       ');
    console.log('====================================\n');
    
    const users = await User.find({}, '-password');
    console.log(users);
    
    console.log('\nTotal Users Count:', users.length);
    console.log('====================================\n');
    mongoose.connection.close();
  } catch (err) {
    console.error('Error fetching users:', err);
  }
}

showUsers();