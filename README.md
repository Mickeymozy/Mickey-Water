# Water Billing System

A modern water utility billing platform built with Node.js, Express, MongoDB, and Passport authentication.

## Features

✅ **User Authentication**
- Local signup/login
- Google OAuth integration
- Password reset flow with admin approval
- Session management

✅ **Water Billing Records**
- View personal usage records with meter readings
- Calculate usage-based charges
- Track billing history

✅ **Admin Dashboard**
- Manage users and records
- Approve password reset requests
- Send notifications to users
- View system statistics

✅ **Payment Integration**
- Zenopay payment gateway integration
- Secure checkout sessions

✅ **Email Notifications**
- SMTP-based email delivery
- Password reset confirmations
- Admin notifications

✅ **Security**
- Bcrypt password hashing
- CSRF protection via session tokens
- Secure headers (X-Frame-Options, CSP, etc.)
- Rate limiting ready
- HTTPS/TLS support

## Prerequisites

- **Node.js** v16+ with npm
- **MongoDB** instance (local or Atlas)
- **SMTP Service** (Gmail, SendGrid, etc.)
- **Google OAuth** credentials (optional, for social login)
- **Zenopay API** key (for payment gateway)

## Installation

### 1. Clone Repository
```bash
git clone <repository-url>
cd Mickey-Water
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration

Copy the example file and add your credentials:
```bash
cp .env.example .env
```

Then edit `.env` with your values:
```env
# Server
NODE_ENV=production
PORT=3000
APP_URL=https://your-domain.com

# Database
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/waterbilling

# Security
SESSION_SECRET=your-random-secret-key

# Email (Gmail example)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=Water Billing <noreply@waterbilling.local>

# Google OAuth
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxx
GOOGLE_CALLBACK_URL=https://your-domain.com/auth/google/callback

# Zenopay
ZENOPAY_API_KEY=your-api-key
ZENOPAY_API_URL=https://api.zenoapi.com
```

### 4. Generate VAPID Keys (Optional, for push notifications)
```bash
node generate-keys.js
```

Add the output keys to `.env`:
```env
VAPID_PUBLIC_KEY=xxxxx
VAPID_PRIVATE_KEY=xxxxx
```

## Usage

### Development Mode
```bash
npm run dev
```
Server runs on `http://localhost:3000`

### Production Mode
```bash
npm start
```

## API Endpoints

### Authentication
- `POST /signup` - Register new user
- `POST /local-login` - Login with email/password
- `GET /auth/google` - Google OAuth login
- `GET /auth/google/callback` - OAuth callback
- `GET /logout` - Logout user
- `GET /api/me` - Get current user info

### Records
- `GET /get-records?page=1&limit=20` - List user's records (paginated)
- `POST /save-record` - Create new billing record
- `GET /api/records/count` - Get total record count (admin)
- `GET /api/records/all` - List all records (admin)
- `PUT /api/records/:id` - Update record (admin)
- `DELETE /api/records/:id` - Delete record (admin)

### Admin
- `GET /api/users/list` - List all users
- `GET /api/users/count` - Get user count
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user
- `GET /api/password-reset-requests` - List reset requests
- `POST /api/admin/approve-password-reset` - Approve reset
- `POST /api/admin/reset-user-password` - Force password reset
- `POST /api/send-notification` - Send system notification

### Payment
- `POST /api/zenopay/checkout` - Create payment session

## File Structure

```
├── server.js              # Express server & API endpoints
├── admin.js              # Admin dashboard logic
├── records.js            # Records page logic
├── admin.html            # Admin dashboard UI
├── records.html          # Records page UI
├── login.html            # Login/signup page
├── index.html            # Home page
├── package.json          # Dependencies
├── .env.example          # Environment template
├── generate-keys.js      # VAPID key generator
└── service-worker.js     # Service worker for PWA
```

## Database Models

### User Schema
```javascript
{
  id: String,
  name: String,
  email: String (unique),
  passwordHash: String,
  googleId: String,
  provider: String ('local' or 'google'),
  picture: String,
  resetToken: String,
  resetExpiry: Date,
  lastLogin: Date,
  createdAt: Date
}
```

### Record Schema
```javascript
{
  userId: String,
  name: String,
  phone: String,
  prev: Number (previous meter reading),
  curr: Number (current meter reading),
  usage: Number (curr - prev),
  total: Number (calculated amount),
  createdAt: Date
}
```

## Email Setup Guide

### Gmail
1. Enable 2-Factor Authentication
2. Generate App Password: https://myaccount.google.com/apppasswords
3. Use app password in `EMAIL_PASSWORD`

### Other SMTP Services
Configure host, port, and credentials in `.env`

## Deployment

### Render.com Example
```bash
# Push to GitHub
git push origin main

# Connect Render to GitHub repo
# Add environment variables in Render dashboard
# Deploy from GitHub
```

### Environment Variables for Production
```env
NODE_ENV=production
MONGODB_URI=<your-production-mongo-uri>
SESSION_SECRET=<generate-secure-random-key>
GOOGLE_CALLBACK_URL=<your-production-url>/auth/google/callback
```

## Security Checklist

- [ ] Change `SESSION_SECRET` to a random string
- [ ] Set `NODE_ENV=production`
- [ ] Use HTTPS in production
- [ ] Store all credentials in `.env` (never commit!)
- [ ] Enable MongoDB authentication
- [ ] Set strong SMTP credentials
- [ ] Configure Google OAuth properly
- [ ] Review admin email list in server.js
- [ ] Enable rate limiting for login attempts

## Troubleshooting

### Email not sending
- Check SMTP credentials in `.env`
- Verify email service allows app passwords
- Check firewall/network connectivity

### Google OAuth not working
- Verify `GOOGLE_CALLBACK_URL` matches OAuth config
- Ensure redirect URI is HTTPS in production
- Check Client ID and Secret are correct

### Records not loading
- Verify MongoDB connection string
- Check user authentication status
- Review browser console for errors

### Admin dashboard access denied
- Ensure user email is in `adminEmails` array in server.js
- Clear browser cookies and re-login

## License

MIT

## Support

For issues and questions, please open an issue on GitHub or contact the development team.
