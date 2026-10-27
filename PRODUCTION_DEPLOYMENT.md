# Production Deployment Guide - IS King Panel

## Prerequisites
- Windows 10/11 64-bit
- Node.js 18+ 
- SQLite 3.40+
- MongoDB 6.0+ (optional)
- 4GB RAM minimum
- 10GB disk space

## Deployment Steps

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
1. Copy `.env.example` to `.env`
2. Update OAuth client credentials
3. Set SESSION_SECRET to a strong random string
4. Configure SMTP settings for password reset

### 3. Database Setup
```bash
# Initialize SQLite database
npx sqlite3 database/isking_panel.sqlite < database/schema.sql
```

### 4. Build Application
```bash
npm run build
npm run electron:build
```

### 5. Run Production Server
```bash
NODE_ENV=production npm start
```

## Security Checklist

- [ ] Change default admin password
- [ ] Configure HTTPS with valid certificate
- [ ] Set up firewall rules
- [ ] Enable MongoDB authentication
- [ ] Configure regular database backups
- [ ] Set up intrusion detection
- [ ] Update OAuth redirect URIs
- [ ] Enable 2FA for admin accounts
- [ ] Configure rate limiting
- [ ] Set up log monitoring

## Post-Deployment
1. Test all authentication flows
2. Verify OAuth providers work correctly
3. Test password reset functionality
4. Check session management
5. Monitor error logs
6. Verify backup schedules

## Troubleshooting
- Check logs in `logs/server.log`
- Verify database permissions
- Check OAuth callback URLs match configuration
- Ensure port 3000 is open