require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const SibApiV3Sdk = require('sib-api-v3-sdk'); 
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js'); // ✅ Sirf ek baar yahan declare kiya hai

const app = express();

// --- SUPABASE CLIENT SETUP ---
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

// --- SAFE FOLDER CREATION ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// --- MIDDLEWARES ---
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// --- DATABASE CONNECTION ---
const pool = require('./db');

// --- DATABASE TABLES INITIALIZATION ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, full_name TEXT, email TEXT UNIQUE, mobile_no TEXT UNIQUE, username TEXT UNIQUE, password TEXT,
                is_verified BOOLEAN DEFAULT FALSE, wallet_balance DECIMAL DEFAULT 0, earning_balance DECIMAL DEFAULT 0,
                terms_accepted BOOLEAN DEFAULT FALSE, kyc_status TEXT DEFAULT 'not_submitted'
            );
            CREATE TABLE IF NOT EXISTS battles (
                id SERIAL PRIMARY KEY, creator_id INTEGER, joiner_id INTEGER, amount DECIMAL, room_code TEXT, status TEXT,
                result_status TEXT, screenshot_url TEXT, winner_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY, user_id INTEGER, amount DECIMAL, utr_no TEXT, status TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY, user_id INTEGER, amount DECIMAL, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database Ready.");
    } catch (err) { console.error("❌ DB Init Error:", err.message); }
};
initDB();

// --- MULTER STORAGE ---
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

let otpStore = {};

// --- ROUTES ---

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

// 2. SEND OTP via FAST2SMS (Existing Code - Don't Delete)
app.post('/api/send-otp', async (req, res) => {
    let { mobile } = req.body;
    try {
        mobile = mobile.toString().replace(/\D/g, ""); 
        if (mobile.length > 10) mobile = mobile.slice(-10);
        const userRes = await pool.query('SELECT * FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "Mobile registered nahi hai!" });
        const otp = Math.floor(100000 + Math.random() * 900000);
        otpStore[mobile] = otp;
        const fast2smsKey = 'CKhGw2uVQxU5JFlBv83OzftpL0ad1Nine6bHSqZRsAXrED4PIo9fvE5CBP3iFtm10IRwguX4qNMnlVjD'; 
        const apiUrl = `https://www.fast2sms.com/dev/bulkV2?authorization=${fast2smsKey}&route=q&message=${encodeURIComponent('Aapka Khel Bhai Ludo OTP hai: ' + otp)}&language=english&flash=0&numbers=${mobile}`;
        const response = await axios.get(apiUrl);
        if (response.data.return) { res.json({ success: true, message: "OTP bhej diya gaya hai!" }); }
        else { res.status(400).json({ error: response.data.message[0] || "SMS failed" }); }
    } catch (err) { res.status(500).json({ error: "Service Busy" }); }
});

// NEW ROUTE: Firebase OTP Verification Check
app.post('/api/verify-login-firebase', async (req, res) => {
    let { mobile } = req.body;
    try {
        // Mobile cleaning: Agar +91 hai toh hata do, sirf aakhri 10 digits lo
        mobile = mobile.toString().replace(/\D/g, ""); 
        if (mobile.length > 10) mobile = mobile.slice(-10);

        console.log("Checking DB for cleaned mobile:", mobile);

        const userRes = await pool.query('SELECT id, terms_accepted, is_verified FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        
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
        console.error("Firebase Login Error:", err.message);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});



// --- 1. Terms Accept Karne Ka Route ---
app.post('/api/accept-terms', async (req, res) => {
    const { userId } = req.body;
    
    console.log("Terms acceptance request for User ID:", userId);

    try {
        // Database mein terms_accepted ko true set karein
        const result = await pool.query(
            'UPDATE users SET terms_accepted = true WHERE id = $1 RETURNING *', 
            [userId]
        );

        if (result.rowCount > 0) {
            console.log(`✅ User ${userId} ne terms accept kar liye hain.`);
            res.json({ success: true, message: "Terms accepted successfully!" });
        } else {
            res.status(404).json({ success: false, error: "User nahi mila!" });
        }
    } catch (err) {
        console.error("❌ Terms Update Error:", err.message);
        res.status(500).json({ success: false, error: "Database error: " + err.message });
    }
});






// Purana Verify Login (OTP Store wala)
app.post('/api/verify-login', async (req, res) => {
    const { mobile, otp } = req.body;
    try {
        if (!otpStore[mobile] || otpStore[mobile] != otp) return res.status(400).json({ error: "Invalid OTP!" });
        const userRes = await pool.query('SELECT id, terms_accepted FROM users WHERE mobile_no = $1', [mobile]);
        const user = userRes.rows[0];
        delete otpStore[mobile];
        res.json({ success: true, userId: user.id, termsAccepted: user.terms_accepted });
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});


// --- 1. User Profile Detail (Naam aur Balance ke liye) ---
app.get('/api/user/details/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT username, full_name, mobile_no, wallet_balance, earning_balance, kyc_status, created_at FROM users WHERE id = $1', 
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- 2. Game History (Play Ludo/Win click ke liye) ---
app.get('/api/user/game-history/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM battles WHERE creator_id = $1 OR joiner_id = $1 ORDER BY created_at DESC', 
            [req.params.id]
        );
        res.json(result.rows); // Agar khali hai toh [] jayega
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. Transaction History (Wallet transaction ke liye) ---
app.get('/api/user/transactions/:id', async (req, res) => {
    try {
        const result = await pool.query(

            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', 
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});





// 3. Battles
app.post('/api/battles/create', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        await pool.query('BEGIN');
        
        // Creator ka balance check karein
        const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        const balance = parseFloat(userRes.rows[0].wallet_balance);

        if (balance < parseFloat(amount)) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Paryapt balance nahi hai!" });
        }

        // 1. Creator ke paise turant deduct karein
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amount, userId]);

        // 2. Battle create karein
        const result = await pool.query(
            'INSERT INTO battles (creator_id, amount, status) VALUES ($1, $2, $3) RETURNING id', 
            [userId, amount, 'open']
        );

        await pool.query('COMMIT');
        res.json({ success: true, battleId: result.rows[0].id });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});


// --- BATTLES LIST ROUTE ---
app.get('/api/battles/list', async (req, res) => {
    try {
        // Sirf 'open' status waali battles dikhani hain jisme kisi ne join nahi kiya
        const result = await pool.query(`
            SELECT b.*, u.username 
            FROM battles b 
            JOIN users u ON b.creator_id = u.id 
            WHERE b.status = 'open' 
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Battles Error:", err.message);
        res.status(500).json({ error: "Server error" });
    }
});


// 3. Join Challenge
app.post('/api/battles/join', async (req, res) => {
    const { userId, battleId } = req.body;

    try {
        await pool.query('BEGIN');

        // 1. Battle fetch aur lock (FOR UPDATE zaroori hai)
        const battleRes = await pool.query('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [battleId]);
        const battle = battleRes.rows[0];

        if (!battle) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "Battle nahi mili!" });
        }

        if (battle.status !== 'open') {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Battle full ho chuki hai!" });
        }

        if (battle.creator_id == userId) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Aap apni hi battle join nahi kar sakte!" });
        }

        // 2. Joiner balance check
        const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        const userBalance = parseFloat(userRes.rows[0].wallet_balance);
        const battleAmt = parseFloat(battle.amount); // Yahan fix kiya hai

        if (userBalance < battleAmt) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Paryapt balance nahi hai!" });
        }

        // 3. Joiner balance deduct karein
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [battleAmt, userId]);

        // 4. Battle status update
        await pool.query('UPDATE battles SET joiner_id = $1, status = \'joined\' WHERE id = $2', [userId, battleId]);

        // 5. Transaction History entry
        // Dhyan dein: Agar 'type' column nahi hai toh pehle database mein add karein
        await pool.query(
            'INSERT INTO transactions (user_id, amount, status, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)', 
            [userId, battleAmt, 'success']
        );

        await pool.query('COMMIT');
        console.log(`✅ Battle Joined: ${battleId} by User ${userId}`);
        res.json({ success: true });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Join Error Details:", err.message); // Render logs mein error dekhein
        res.status(500).json({ success: false, error: "Server Internal Error: " + err.message });
    }
});


// --- BATTLE STATUS CHECK (Creator ke liye) ---
app.get('/api/battles/status/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT status, joiner_id FROM battles WHERE id = $1', [req.params.id]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: "Not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// A. Battle Details Fetch karna
app.get('/api/battles/details/:id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, u1.username as creator_name, u2.username as joiner_name 
            FROM battles b 
            JOIN users u1 ON b.creator_id = u1.id 
            LEFT JOIN users u2 ON b.joiner_id = u2.id 
            WHERE b.id = $1`, [req.params.id]);
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

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Naya submit-result route
app.post('/api/battles/submit-result', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, battleId, status } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ error: "Screenshot missing" });

        // Supabase Storage mein upload karein
        const fileName = `${Date.now()}_${file.originalname}`;
        const { data, error } = await supabase.storage
            .from('screenshots')
            .upload(fileName, file.buffer, {
                contentType: file.mimetype
            });

        if (error) throw error;

        // Public URL generate karein
        const { data: urlData } = supabase.storage
            .from('screenshots')
            .getPublicUrl(fileName);

        const publicUrl = urlData.publicUrl;

        // Database mein publicUrl save karein
        await pool.query(
            'UPDATE battles SET result_status = $1, screenshot_url = $2, status = $3 WHERE id = $4',
            [status, publicUrl, 'pending_approval', battleId]
        );

        res.json({ success: true, message: "Uploaded to Supabase Storage!" });
    } catch (err) {
        console.error("Supabase Upload Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});



app.post('/api/user/submit-kyc', async (req, res) => {
    const { userId, bankAcc, ifsc, upiId, whatsapp } = req.body;
    try {
        await pool.query('UPDATE users SET bank_account_no = $1, ifsc_code = $2, upi_id = $3, whatsapp_no = $4, kyc_status = \'pending\' WHERE id = $5', [bankAcc, ifsc, upiId, whatsapp, userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});



// 5. Withdrawals
app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const user = (await pool.query('SELECT earning_balance FROM users WHERE id = $1', [userId])).rows[0];
        if (parseFloat(user.earning_balance) < parseFloat(amount)) return res.status(400).json({ message: "Low Balance" });
        await pool.query('BEGIN');
        await pool.query('INSERT INTO withdrawals (user_id, amount, status) VALUES ($1, $2, $3)', [userId, amount, 'pending']);
        await pool.query('UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2', [amount, userId]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});


// UPIGateway Order Create
// SIRF ISE RAKHEIN ✅
app.post('/api/pay/create-order', async (req, res) => {
    const { amount, userId } = req.body;
    const client_txn_id = "TXN" + Date.now();

    try {
        // Database se user ka asli mobile aur naam lein taaki gateway reject na kare
        const userRes = await pool.query('SELECT full_name, mobile_no FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0] || { full_name: "Ludo Player", mobile_no: "7079950417" };

const response = await axios.post('https://api.ekqr.in/api/create_order', {
    "key": "b306734d-dac5-48ce-bdd3-d08b8b7d7f38",
    "client_txn_id": client_txn_id,
    "amount": amount.toString(),
    "p_info": "Wallet Topup",
    "customer_name": user.full_name.substring(0, 15),
    "customer_email": "user@gmail.com",
    "customer_mobile": user.mobile_no.replace(/\D/g, "").slice(-10),
    "redirect_url": "https://autotechsolutions25-netizen.github.io/dashboard.html", // Yahan comma dekho
    "udf1": userId.toString() // Is line se pehle comma missing tha!
});

        console.log("UPIGateway Response:", response.data);

        if (response.data && response.data.status === true) {
            res.json({ success: true, payment_data: response.data.data });
        } else {
            res.status(400).json({ 
                success: false, 
                error: response.data.msg || "Gateway Error" 
            });
        }
    } catch (err) {
        console.error("Gateway Error:", err.response ? err.response.data : err.message);
        res.status(500).json({ success: false, error: "Gateway Busy or Connection Fail" });
    }
});



app.post('/api/webhook/upigateway', async (req, res) => {
    const { status, client_txn_id, amount, udf1 } = req.body; // udf1 mein humne userId bheja tha

    if (status === 'success') {
        try {
            // 1. Transaction record update karein
            await pool.query('INSERT INTO transactions (user_id, amount, utr_no, status, type) VALUES ($1, $2, $3, $4, $5)', 
            [udf1, amount, client_txn_id, 'success', 'deposit']);

            // 2. User ka Wallet Update karein
            await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, udf1]);

            console.log(`✅ Wallet Updated for User ${udf1}: ₹${amount}`);
            res.send('OK'); // Gateway ko batayein ki humne data process kar liya
        } catch (err) {
            console.error("Webhook Error:", err.message);
            res.status(500).send('Database Error');
        }
    } else {
        res.send('Not Success');
    }
});



// --- ADMIN SYSTEM ROUTES ---

// 1. Admin Login Verification
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const ADMIN_PASSWORD = "Praveen@123"; // Aap ise yahan se badal sakte hain

    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: "ADMIN_SESSION_ACTIVE" });
    } else {
        res.status(401).json({ success: false, message: "Galat Password!" });
    }
});


// --- ADMIN: Pending Battle Results Fetch Karein ---
app.get('/api/admin/battles/pending-details', async (req, res) => {
    try {
        const query = `
            SELECT b.*, 
            u1.username as creator_name, 
            u2.username as joiner_name 
            FROM battles b
            JOIN users u1 ON b.creator_id = u1.id
            LEFT JOIN users u2 ON b.joiner_id = u2.id
            WHERE b.status = 'pending_approval' OR (b.status = 'joined' AND b.screenshot_url IS NOT NULL)
            ORDER BY b.created_at DESC`;
            
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Admin Battle Fetch Error:", err.message);
        res.status(500).json({ error: "Server error" });
    }
});

// --- ADMIN: Master Stats Update (Count fix karne ke liye) ---
// --- ADMIN: Master Stats Logic ---
app.get('/api/admin/master-stats', async (req, res) => {
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const kyc = await pool.query('SELECT COUNT(*) FROM users WHERE is_verified = false');
        const withdraw = await pool.query('SELECT COUNT(*) FROM withdrawals WHERE status = \'pending\'');
        
        // Is query ko dhyan se dekhein: Ye un battles ko ginta hai jinhe verify karna hai
        const battles = await pool.query("SELECT COUNT(*) FROM battles WHERE status = 'pending_approval' OR (status = 'joined' AND screenshot_url IS NOT NULL)");
        
        res.json({
            totalUsers: parseInt(users.rows[0].count),
            pendingKyc: parseInt(kyc.rows[0].count),
            pendingWithdrawals: parseInt(withdraw.rows[0].count),
            pendingBattles: parseInt(battles.rows[0].count)
        });
    } catch (err) {
        console.error("Stats Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});


// Winner Approve karne aur Paise Transfer karne ka Route
app.post('/api/admin/battles/verify-winner', async (req, res) => {
    const { battleId, winnerId } = req.body;
    try {
        await pool.query('BEGIN');

        // 1. Battle info nikaalein
        const battleRes = await pool.query('SELECT amount FROM battles WHERE id = $1', [battleId]);
        const amount = parseFloat(battleRes.rows[0].amount);
        const prize = amount * 1.90; // 10% Platform fee kaat kar 90% profit

        // 2. Winner ke account mein paise daalein
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [prize, winnerId]);

        // 3. Battle status update karein
        await pool.query('UPDATE battles SET status = \'completed\', winner_id = $1 WHERE id = $2', [winnerId, battleId]);

        await pool.query('COMMIT');
        res.json({ success: true, message: "Payment released to winner!" });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});



// 3. Pending Users List (KYC ke liye)
app.get('/api/admin/pending-users', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE is_verified = false ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. User Approve karne ka Route
app.post('/api/admin/approve-user', async (req, res) => {
    const { userId } = req.body;
    try {
        await pool.query('UPDATE users SET is_verified = true, kyc_status = \'approved\' WHERE id = $1', [userId]);
        res.json({ success: true, message: "User approved!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// 3. Pending Users List (New User ke liye)
app.get('/api/admin/users/list', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, username, mobile_no, wallet_balance, is_verified FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
