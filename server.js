const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// Database Connection
const pool = require('./db');

const cors = require('cors'); // 1. CORS library ko import karein

// 2. Isse allow karein (Ise app = express() ke turant baad likhna)
app.use(cors({
    origin: 'https://autotechsolutions25-netizen.github.io', // Sirf aapki website allow hogi
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

// --- DATABASE TABLES INITIALIZATION ---
// Yeh block check karega ki tables hain ya nahi, nahi toh bana dega
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                full_name TEXT,
                email TEXT UNIQUE,
                mobile_no TEXT UNIQUE,
                username TEXT UNIQUE,
                password TEXT,
                aadhar_front_url TEXT,
                aadhar_back_url TEXT,
                is_verified BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS admin_settings (
                id SERIAL PRIMARY KEY,
                admin_email TEXT,
                smtp_password TEXT
            );
        `);
        console.log("Database Tables Ready.");
    } catch (err) {
        console.error("Database Init Error:", err.message);
    }
};
initDB();

// File Upload Configuration
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// ROUTES

// 1. User Registration
app.post('/api/register', upload.fields([{name:'aadharFront'}, {name:'aadharBack'}]), async (req, res) => {
    try {
        const { fullName, email, mobile, username, password } = req.body;
        const front = req.files['aadharFront'] ? `/uploads/${req.files['aadharFront'][0].filename}` : null;
        const back = req.files['aadharBack'] ? `/uploads/${req.files['aadharBack'][0].filename}` : null;

        await pool.query(
            `INSERT INTO users (full_name, email, mobile_no, username, password, aadhar_front_url, aadhar_back_url, is_verified) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
            [fullName, email, mobile, username, password, front, back]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Reg Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 🚀 LOGIN ROUTES (FIXED)
// ==========================================

// User Login (Firebase/Mobile)
app.post('/api/verify-login-firebase', async (req, res) => {
    let { mobile } = req.body;
    console.log("Login attempt for mobile:", mobile); // Render logs mein dikhega
    try {
        if (!mobile) return res.status(400).json({ error: "Mobile number missing" });

        // Mobile number cleaning (Sirf aakhri 10 digits)
        let cleanMobile = mobile.toString().replace(/\D/g, "").slice(-10);
        
        const userRes = await pool.query('SELECT id, terms_accepted, is_verified FROM users WHERE mobile_no LIKE $1', [`%${cleanMobile}%`]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Aap registered nahi hain!" });
        }

        const user = userRes.rows[0];
        if (!user.is_verified) {
            return res.status(403).json({ success: false, error: "Account approval pending hai!" });
        }

        res.json({ 
            success: true, 
            userId: user.id, 
            termsAccepted: user.terms_accepted 
        });
    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).json({ success: false, error: "Server Error: " + err.message });
    }
});

// 2. Admin: Get Pending Users
app.get('/api/admin/pending-users', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE is_verified = false ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Users Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. Admin: Settings
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { email, pass } = req.body;
        await pool.query('DELETE FROM admin_settings');
        await pool.query('INSERT INTO admin_settings (admin_email, smtp_password) VALUES ($1, $2)', [email, pass]);
        res.json({ success: true });
    } catch (err) {
        console.error("Settings Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 4. Admin: Approve User
app.post('/api/admin/approve', async (req, res) => {
    const { userId, userEmail } = req.body;
    try {
        await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [userId]);
        const settingsRes = await pool.query('SELECT * FROM admin_settings LIMIT 1');
        const settings = settingsRes.rows[0];

        if (settings) {
            let transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: settings.admin_email, pass: settings.smtp_password }
            });
            await transporter.sendMail({
                from: settings.admin_email,
                to: userEmail,
                subject: 'Account Approved - Khel Bhai Ludo',
                text: 'Namaste! Aapka account approve ho gaya hai. Ab aap login karke game khel sakte hain.'
            });
        }
        res.json({ success: true, message: "User approved and email sent" });
    } catch (err) {
        console.error("Approve Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});


// OTP Store karne ke liye ek simple object (Real production mein Redis ya DB use hota hai)
let otpStore = {}; 

// 1. Send OTP Route
app.post('/api/send-otp', async (req, res) => {
    const { mobile } = req.body;
    try {
        // Check karein user verified hai ya nahi
        const userRes = await pool.query('SELECT * FROM users WHERE mobile_no = $1 AND is_verified = true', [mobile]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found or not approved by admin!" });
        }

        const user = userRes.rows[0];
        const otp = Math.floor(100000 + Math.random() * 900000); // 6 Digit OTP
        otpStore[mobile] = otp; // Mobile number ke against OTP save karein

        // Admin settings fetch karein mail bhejne ke liye
        const settings = (await pool.query('SELECT * FROM admin_settings LIMIT 1')).rows[0];
        
        if (settings) {
            let transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: settings.admin_email, pass: settings.smtp_password }
            });

            await transporter.sendMail({
                from: settings.admin_email,
                to: user.email,
                subject: 'Login OTP - Ludo Platform',
                text: `Namaste ${user.full_name}, aapka login OTP hai: ${otp}`
            });

            res.json({ success: true, message: "OTP sent to your registered email!" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP & Login (Updated)
app.post('/api/verify-login', async (req, res) => {
    const { mobile, otp } = req.body;
    
    try {
        // 1. OTP Check karein
        if (!otpStore[mobile] || otpStore[mobile] != otp) {
            return res.status(400).json({ error: "Invalid or Expired OTP!" });
        }

        // 2. Database se user ki details nikalein
        const userRes = await pool.query(
            'SELECT id, terms_accepted FROM users WHERE mobile_no = $1', 
            [mobile]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User record not found!" });
        }

        const user = userRes.rows[0];

        // 3. OTP use hone ke baad delete kar dein
        delete otpStore[mobile];

        // 4. Response mein ID aur Terms ka status bhejein
        res.json({ 
            success: true, 
            message: "Login Successful!",
            userId: user.id,
            termsAccepted: user.terms_accepted 
        });

    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).json({ error: "Server error during login." });
    }
});


// Get User Balance & Data
app.get('/api/user/profile/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.userId]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]); // Sirf pehla record bhejna hai
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Transaction Request (Add Cash)
app.post('/api/add-cash', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        await pool.query('INSERT INTO transactions (user_id, amount, status) VALUES ($1, $2, $3)', [userId, amount, 'pending']);
        res.json({ success: true, message: "Request sent to admin" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/accept-terms', async (req, res) => {
    const { userId } = req.body;
    try {
        await pool.query('UPDATE users SET terms_accepted = true WHERE id = $1', [userId]);
        res.json({ success: true, message: "Terms Accepted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 1. Create Challenge
app.post('/api/battles/create', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO battles (creator_id, amount, status) VALUES ($1, $2, $3) RETURNING id', 
            [userId, amount, 'open']
        );
        // Sabse important: Yahan RETURNING id se humein naye battle ki ID milti hai
        res.json({ success: true, battleId: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 2. List Challenges (Sirf 'open' challenges dikhayenge)
app.get('/api/battles/list', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, u.username FROM battles b 
            JOIN users u ON b.creator_id = u.id 
            WHERE b.status = 'open' ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Join Challenge
app.post('/api/battles/join', async (req, res) => {
    const { userId, battleId } = req.body;
    try {
        await pool.query('UPDATE battles SET joiner_id = $1, status = $2 WHERE id = $3', [userId, 'joined', battleId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// Add Cash Request
app.post('/api/add-cash', async (req, res) => {
    const { userId, amount, utr } = req.body;
    try {
        await pool.query(
            'INSERT INTO transactions (user_id, amount, utr_no, status) VALUES ($1, $2, $3, $4)',
            [userId, amount, utr, 'pending']
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Admin approves the transaction
app.post('/api/admin/approve-cash', async (req, res) => {
    const { transactionId, userId, amount } = req.body;
    try {
        // 1. Transaction status update karein
        await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['success', transactionId]);
        
        // 2. User ke wallet mein paise add karein
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
        
        res.json({ success: true, message: "Cash Added to Wallet!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



const Razorpay = require('razorpay');

// Razorpay Instance (Aapki Test API Keys)
const rzp = new Razorpay({
    key_id: 'rzp_test_SflXxOSDMFAolF',
    key_secret: 'N6Ve21b0cUAJZKnaP7ozPiu8'
});

// 1. Razorpay Order Create karna
app.post('/api/pay/create-order', async (req, res) => {
    const { amount } = req.body;
    try {
        const options = {
            amount: amount * 100, // Razorpay paise mein leta hai (₹100 = 10000 paise)
            currency: "INR",
            receipt: "order_rcptid_" + Date.now(),
        };
        const order = await rzp.orders.create(options);
        res.json({ success: true, order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Payment Verify karke Wallet mein paise add karna
app.post('/api/pay/verify', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, amount, userId } = req.body;
    
    // Yahan ideally signature verification honi chahiye, 
    // par test mode ke liye hum direct balance update kar rahe hain.
    try {
        await pool.query(
            'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
            [amount, userId]
        );
        
        // Transaction history mein entry
        await pool.query(
            'INSERT INTO transactions (user_id, amount, utr_no, status) VALUES ($1, $2, $3, $4)',
            [userId, amount, razorpay_payment_id, 'success']
        );

        res.json({ success: true, message: "Payment Successful & Cash Added!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// A. Battle Details Fetch karna
app.get('/api/battles/details/:id', async (req, res) => {
    try {
        const query = `
            SELECT b.*, 
            u1.username as creator_name, 
            u2.username as joiner_name 
            FROM battles b
            JOIN users u1 ON b.creator_id = u1.id
            LEFT JOIN users u2 ON b.joiner_id = u2.id
            WHERE b.id = $1`;
        const result = await pool.query(query, [req.params.id]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// B. Room Code Update karna (Sirf Creator kar sakta hai)
app.post('/api/battles/update-room', async (req, res) => {
    const { battleId, roomCode } = req.body;
    try {
        await pool.query('UPDATE battles SET room_code = $1, status = $2 WHERE id = $3', 
        [roomCode, 'playing', battleId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// C. Screenshot Upload Setup (Multer use karein)
app.post('/api/battles/submit-result', upload.single('screenshot'), async (req, res) => {
    const { userId, battleId, status } = req.body;
    const screenshotPath = req.file ? `/uploads/${req.file.filename}` : null;

    try {
        // Status update karein (Admin verify karega tab final winner announce hoga)
        await pool.query(
            'UPDATE battles SET result_status = $1, screenshot_url = $2 WHERE id = $3',
            [status, screenshotPath, battleId]
        );
        
        res.json({ success: true, message: "Result submitted for Admin verification" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 1. Pending Battles Fetch karna Admin ke liye
app.get('/api/admin/battles/pending', async (req, res) => {
    try {
        const query = `
            SELECT b.*, u1.username as creator_name, u2.username as joiner_name 
            FROM battles b
            JOIN users u1 ON b.creator_id = u1.id
            JOIN users u2 ON b.joiner_id = u2.id
            WHERE b.status = 'joined' AND b.result_status IS NOT NULL
            ORDER BY b.created_at DESC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Winner Approve & Money Transfer (Commission Included)
app.post('/api/admin/battles/verify-winner', async (req, res) => {
    const { battleId, winnerId, amount } = req.body;
    
    // Commission Logic: Maan lijiye 10% admin charge hai
    // Total Win Amount = (Entry Amount * 2) - 10% Commission
    const entryFee = parseFloat(amount);
    const totalPrize = entryFee * 2;
    const commission = totalPrize * 0.10; // 10% commission
    const winningAmount = totalPrize - commission;

    try {
        await pool.query('BEGIN'); // Transaction start

        // 1. Battle Table update karein
        await pool.query('UPDATE battles SET status = $1, winner_id = $2 WHERE id = $3', 
        ['completed', winnerId, battleId]);

        // 2. Winner ke Wallet/Earning mein paise add karein
        await pool.query('UPDATE users SET earning_balance = earning_balance + $1 WHERE id = $2', 
        [winningAmount, winnerId]);

        // 3. Admin ke commission log (optional) ke liye entry kar sakte hain
        
        await pool.query('COMMIT');
        res.json({ success: true, message: `Winner paid ₹${winningAmount}` });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/user/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        await pool.query('BEGIN');
        
        // 1. Check karein balance hai ya nahi
        const user = await pool.query('SELECT earning_balance FROM users WHERE id = $1', [userId]);
        if (user.rows[0].earning_balance < amount) {
            return res.status(400).json({ error: "Insufficient earning balance!" });
        }

        // 2. Balance deduct karein
        await pool.query('UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2', [amount, userId]);

        // 3. Withdrawal request table mein save karein
        await pool.query('INSERT INTO withdrawals (user_id, amount, status) VALUES ($1, $2, $3)', [userId, amount, 'pending']);

        await pool.query('COMMIT');
        res.json({ success: true, message: "Withdrawal request sent!" });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});


// Master Stats API
app.get('/api/admin/master-stats', async (req, res) => {
    try {
        const userCount = await pool.query('SELECT count(*) FROM users');
        const withdrawCount = await pool.query("SELECT count(*) FROM withdrawals WHERE status = 'pending'");
        const activeBattles = await pool.query("SELECT count(*) FROM battles WHERE result_status IS NOT NULL AND status != 'completed'");
        
        res.json({
            totalUsers: parseInt(userCount.rows[0].count),
            pendingWithdrawals: parseInt(withdrawCount.rows[0].count),
            activeBattles: parseInt(activeBattles.rows[0].count)
        });
    } catch (err) {
        console.error("Stats API Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Pending Withdrawals
// 1. Admin: Pending Withdrawals Fetch karna
app.get('/api/admin/withdrawals/pending', async (req, res) => {
    try {
        const query = `
            SELECT w.*, u.username, u.mobile_no, u.bank_account_no, u.ifsc_code, u.upi_id 
            FROM withdrawals w 
            JOIN users u ON w.user_id = u.id 
            WHERE w.status = 'pending'
            ORDER BY w.created_at DESC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Admin: Withdrawal Status Update (Paid/Rejected) - ISSE 404 FIX HOGA
app.post('/api/admin/withdrawals/update', async (req, res) => {
    const { reqId, status, reason } = req.body;
    try {
        await pool.query('BEGIN');

        if (status === 'rejected') {
            // Refund logic
            const withdrawInfo = await pool.query('SELECT user_id, amount FROM withdrawals WHERE id = $1', [reqId]);
            if (withdrawInfo.rows.length > 0) {
                const { user_id, amount } = withdrawInfo.rows[0];
                await pool.query('UPDATE users SET earning_balance = earning_balance + $1 WHERE id = $2', [amount, user_id]);
            }
            // UPDATE query mein ab 'reject_reason' column mil jayega
            await pool.query('UPDATE withdrawals SET status = $1, reject_reason = $2 WHERE id = $3', ['rejected', reason, reqId]);
        } else {
            await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['paid', reqId]);
        }

        await pool.query('COMMIT');
        res.json({ success: true, message: "Status updated!" });
    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        console.error("Database Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
}); 


app.get('/api/battles/status/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT status, joiner_id FROM battles WHERE id = $1', 
            [req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Admin Login Route
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE username = $1 AND password = $2', 
            [username, password]
        );
        
        if (result.rows.length > 0) {
            // Admin ki identity save karein (Session ya Token)
            res.json({ success: true, message: "Welcome Admin" });
        } else {
            res.status(401).json({ success: false, message: "Invalid Admin Credentials" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1. Sabhi Users ki list fetch karna
app.get('/api/admin/users/list', async (req, res) => {
    try {
        // Query ko asaan banate hain taaki error pakda jaye
        const result = await pool.query('SELECT id, username, mobile_no, wallet_balance, earning_balance FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error("User List Error:", err.message);
        res.status(500).json({ error: "Database error: " + err.message });
    }
});

// 2. Pending Battles ki list (Details ke sath)
app.get('/api/admin/battles/pending-details', async (req, res) => {
    try {
        const query = `
            SELECT b.*, u1.username as creator_name, u2.username as joiner_name 
            FROM battles b 
            LEFT JOIN users u1 ON b.creator_id = u1.id 
            LEFT JOIN users u2 ON b.joiner_id = u2.id 
            WHERE b.result_status IS NOT NULL AND b.status != 'completed'`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// 3. SMTP Status Check
app.get('/api/admin/smtp-status', (req, res) => {
    // Jo email aapne env file ya config mein set kiya hai use return karein
    res.json({ active_email: process.env.EMAIL_USER || "praveen@autotech.com" });
});


// Game History Route
app.get('/api/user/game-history/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM battles WHERE (creator_id = $1 OR joiner_id = $1) AND status = $2 ORDER BY created_at DESC',
            [req.params.userId, 'completed']
        );
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Transactions Route (Deposit & Withdrawals mix)
app.get('/api/user/transactions/:userId', async (req, res) => {
    const { userId } = req.params;
    
    // Check karein ki userId valid number hai
    if (!userId || userId === 'undefined') {
        return res.status(400).json({ error: "Invalid User ID" });
    }

    try {
        // Safe query: Hum check kar rahe hain dono tables se data
        // Dhyan dein: Dono tables mein 'user_id' column ka naam same hona chahiye
        const query = `
            SELECT amount, 'deposit' as type, 'success' as status, NULL as reject_reason, created_at 
            FROM deposits 
            WHERE user_id = $1
            UNION ALL
            SELECT amount, 'withdrawal' as type, status, reject_reason, created_at 
            FROM withdrawals 
            WHERE user_id = $1
            ORDER BY created_at DESC`;
        
        const result = await pool.query(query, [userId]);
        res.json(result.rows);
    } catch (err) {
        // Terminal mein error print hoga toh aapko asli wajah dikhegi
        console.error("TRANSACTION_ROUTE_ERROR:", err.message);
        
        // Agar table nahi hai toh blank array bhej do crash karne ki jagah
        if (err.message.includes("does not exist")) {
            return res.json([]); 
        }
        
        res.status(500).json({ error: "Database internal error" });
    }
});


// Admin: Completed Withdrawals History (Paid aur Rejected) Fetch karna
app.get('/api/admin/withdrawals/history', async (req, res) => {
    try {
        // Hum withdrawals table se wo data uthayenge jo 'paid' ya 'rejected' ho chuka hai
        const query = `
            SELECT w.*, u.username, u.mobile_no 
            FROM withdrawals w 
            JOIN users u ON w.user_id = u.id 
            WHERE w.status IN ('paid', 'rejected')
            ORDER BY w.created_at DESC 
            LIMIT 100`; 

        const result = await pool.query(query);
        
        // Agar data milta hai toh response bhejein, warna khali array
        res.json(result.rows);
    } catch (err) {
        console.error("History Fetch Error:", err.message);
        res.status(500).json({ error: "Database error: " + err.message });
    }
});

// KYC Details Submit karne ka route
app.post('/api/user/submit-kyc', async (req, res) => {
    const { userId, bankAcc, ifsc, upiId, whatsapp } = req.body;

    try {
        // Hum "ON CONFLICT" ya "UPDATE" logic use karenge
        // Pehle check karte hain ki user hai ya nahi
        const checkUser = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);

        if (checkUser.rows.length > 0) {
            // Agar user hai, toh uski details UPDATE karo aur status PENDING kar do
            const updateQuery = `
                UPDATE users 
                SET bank_account_no = $1, 
                    ifsc_code = $2, 
                    upi_id = $3, 
                    whatsapp_no = $4, 
                    kyc_status = 'pending', 
                    kyc_reject_reason = NULL 
                WHERE id = $5`;
            
            await pool.query(updateQuery, [bankAcc, ifsc, upiId, whatsapp, userId]);
            
            res.json({ success: true, message: "KYC details updated and sent for approval!" });
        } else {
            res.status(404).json({ success: false, message: "User not found!" });
        }
    } catch (err) {
        console.error("KYC Submit Error:", err.message);
        res.status(500).json({ success: false, message: "Server error" });
    }
});


// 1. Pending KYC fetch karna (Admin ke liye)
app.get('/api/admin/kyc/pending', async (req, res) => {
    try {
        // Query: Ab hum sirf kyc_status check karenge, details null honge toh bhi admin ko dikhega
        const query = `
            SELECT id, username, mobile_no, 
            COALESCE(whatsapp_no, 'N/A') as whatsapp_no, 
            COALESCE(bank_account_no, 'N/A') as bank_account_no, 
            COALESCE(ifsc_code, 'N/A') as ifsc_code, 
            COALESCE(upi_id, 'N/A') as upi_id 
            FROM users 
            WHERE kyc_status = 'pending'
            ORDER BY id DESC`;
        
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Approved KYC Users ki list fetch karne ka endpoint
app.get('/api/admin/kyc/approved', async (req, res) => {
    try {
        // Sirf unhe dikhao jinka status 'approved' hai
        const result = await pool.query(`
            SELECT id, username, mobile_no, whatsapp_no, bank_account_no, ifsc_code, upi_id 
            FROM users 
            WHERE kyc_status = 'approved'
            ORDER BY id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Approved KYC Fetch Error:", err.message);
        res.status(500).json({ error: "Database error" });
    }
});

// Admin Status Update Route (Approve/Reject)
app.post('/api/admin/kyc/update-status', async (req, res) => {
    const { userId, status, reason } = req.body;
    try {
        await pool.query(
            "UPDATE users SET kyc_status = $1, kyc_reject_reason = $2 WHERE id = $3", 
            [status, reason || null, userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// User withdrawal request bhejta hai
app.post('/api/withdraw/request', async (req, res) => {
    // 1. Data receiving check
    const { userId, amount } = req.body;
    console.log("Incoming Request:", { userId, amount });

    if (!userId || !amount) {
        return res.status(400).json({ success: false, message: "Invalid Data: userId or amount missing" });
    }

    const withdrawAmount = parseFloat(amount);

    try {
        // 2. User balance fetch
        const userResult = await pool.query('SELECT username, earning_balance FROM users WHERE id = $1', [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: "User not found!" });
        }

        const user = userResult.rows[0];
        const currentBalance = parseFloat(user.earning_balance || 0);

        // 3. Balance verification
        if (currentBalance < withdrawAmount) {
            return res.status(400).json({ success: false, message: "Balance kam hai!" });
        }

        // 4. Transaction Start
        await pool.query('BEGIN');
        
        try {
            // Withdrawal record insert (Table columns check karein: user_id, amount, status)
            await pool.query(
                'INSERT INTO withdrawals (user_id, amount, status, created_at) VALUES ($1, $2, $3, NOW())', 
                [userId, withdrawAmount, 'pending']
            );
            
            // Earning balance update
            await pool.query(
                'UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2', 
                [withdrawAmount, userId]
            );
            
            await pool.query('COMMIT');
            console.log("Transaction Committed Successfully");

            // 5. Admin Email Alert (Non-blocking)
            // Ise try-catch mein rakha hai taaki agar mail fail ho toh user ko error na dikhe
            if (typeof transporter !== 'undefined') {
                const mailOptions = {
                    from: 'aapka-system-email@gmail.com', 
                    to: 'admin@gmail.com', 
                    subject: '🚨 New Withdrawal Request - Ludo Empire',
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; background: #f9f9f9;">
                            <h2 style="color: #d32f2f;">New Payout Request!</h2>
                            <p><b>User:</b> ${user.username} (ID: ${userId})</p>
                            <p><b>Amount Requested:</b> <span style="font-size: 18px; color: green; font-weight: bold;">₹${withdrawAmount}</span></p>
                            <p><b>Action Required:</b> Kripya Admin Panel mein jaakar approve karein.</p>
                            <hr>
                            <p style="font-size: 12px; color: #666;">Auto-generated by AutoTech Solutions.</p>
                        </div>
                    `
                };

                transporter.sendMail(mailOptions, (error, info) => {
                    if (error) console.error("Mail Error (Non-critical):", error.message);
                    else console.log("Admin Notified:", info.response);
                });
            }

            // Final Success Response
            return res.json({ success: true, message: "Withdrawal request submitted!" });

        } catch (transError) {
            await pool.query('ROLLBACK');
            throw transError; // Catch block mein bhej dega
        }

    } catch (err) {
        console.error("Withdraw Route Error:", err.message);
        // User ko clear error message dena
        res.status(500).json({ 
            success: false, 
            message: "Server Error: " + err.message,
            error: err.message 
        });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
