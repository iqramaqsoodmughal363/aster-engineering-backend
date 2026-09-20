const fallbackAdminEmails = [
  'iqra03010511199@gmail.com',
  'masterengineeringworks@gmail.com',
];

const configuredAdminEmails = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL;

const adminEmails = configuredAdminEmails
  ? configuredAdminEmails
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  : fallbackAdminEmails;

const isAdminEmail = (email) => adminEmails.includes((email || '').trim().toLowerCase());

module.exports = { adminEmails, isAdminEmail };
