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
    origin: 'https://autotechsolutions25-netizen.github.io', // Sirf aapki site allow hogi
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
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
// --- MULTER STORAGE SETUP (Sirf ek baar rakhein) ---
const storage = multer.memoryStorage(); 
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit safety ke liye
});

// ROUTES


// 1. User Registration (Strict Database Link Binding)
app.post('/api/register', upload.fields([{name:'aadharFront'}, {name:'aadharBack'}]), async (req, res) => {
    try {
        console.log("--- Supabase Debug Request Body ---", req.body);
        console.log("--- Supabase Debug Files ---", req.files);

        const { fullName, email, mobile, username, password, referred_by } = req.body;
        
        // Strict verification: Check karein agar req.files completely missing hai
        if (!req.files || !req.files['aadharFront'] || !req.files['aadharBack']) {
            return res.status(400).json({ 
                success: false, 
                error: "Backend Error: Aadhaar card images server tak nahi pahunchi! Kripya form aur frontend boundary check karein." 
            });
        }

        // Agar files hain, toh filename extract karein
        const frontFile = req.files['aadharFront'][0];
        const backFile = req.files['aadharBack'][0];

        // Sahi path string format banayein jo Supabase mein store hoga
        const frontUrl = `/uploads/${frontFile.filename}`;
        const backUrl = `/uploads/${backFile.filename}`;

        console.log("Supabase me ye string jaa rhi hai -> Front:", frontUrl, " | Back:", backUrl);

        const parsedReferBy = referred_by && !isNaN(referred_by) ? parseInt(referred_by) : null;

        // Final query execution
        await pool.query(
            `INSERT INTO users (
                full_name, 
                email, 
                mobile_no, 
                username, 
                password, 
                aadhar_front_url, 
                aadhar_back_url, 
                is_verified,
                referred_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)`,
            [fullName, email, mobile, username, password, frontUrl, backUrl, parsedReferBy]
        );
        
        return res.status(200).json({ success: true, message: "Data successfully written to Supabase!" });

    } catch (err) {
        console.error("Supabase Write Error Log:", err.message);
        return res.status(500).json({ success: false, error: "Database Crash: " + err.message });
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


// A. Battle Details Fetch karna (Improved Version)
app.get('/api/battles/details/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // SQL Query check karein ki data mil raha hai ya nahi
        const result = await pool.query(`
            SELECT 
                b.*, 
                u1.username as creator_name, 
                u2.username as joiner_name 
            FROM battles b 
            JOIN users u1 ON b.creator_id = u1.id 
            LEFT JOIN users u2 ON b.joiner_id = u2.id 
            WHERE b.id = $1`, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Battle nahi mili!" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Fetch Battle Error:", err.message);
        res.status(500).json({ error: "Server error occurred" });
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
// C. Screenshot Upload Setup (Multer use karein)
app.post('/api/battles/submit-result', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, battleId, status } = req.body;
        let finalPublicUrl = null;

        // Sirf 'won' status hone par hi file check hogi
        if (status === 'won') {
            if (!req.file) {
                return res.status(400).json({ success: false, error: "Winner ke liye screenshot zaroori hai!" });
            }

            const fileExt = req.file.mimetype.split('/')[1] || 'png';
            const fileName = `${Date.now()}_battle_${battleId}.${fileExt}`;

            const { data: uploadData, error: upError } = await supabase.storage
                .from('screenshots')
                .upload(fileName, req.file.buffer, { 
                    contentType: req.file.mimetype,
                    upsert: true 
                });

            if (upError) throw upError;

            const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(fileName);
            finalPublicUrl = urlData.publicUrl;
        }

        // Database Update (Har case ke liye: won, lost, cancel)
        await pool.query(
            `UPDATE battles SET 
                result_status = $1, 
                screenshot_url = $2, 
                status = $3, 
                winner_id = CASE WHEN $1 = 'won' THEN winner_id ELSE winner_id END 
             WHERE id = $4`,
            [status, finalPublicUrl, 'pending_approval', battleId]
        );

        res.json({ success: true, message: "Result updated successfully!" });

    } catch (err) {
        console.error("Critical Upload Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});


// KYC Submission with Aadhar Upload
app.post('/api/user/submit-kyc', upload.fields([
    { name: 'aadharFront', maxCount: 1 },
    { name: 'aadharBack', maxCount: 1 }
]), async (req, res) => {
    try {
        const { userId, bankAcc, ifsc, upiId, whatsapp } = req.body;
        let frontUrl = null;
        let backUrl = null;

        // 1. Upload Aadhar Front
        if (req.files['aadharFront']) {
            const frontFile = req.files['aadharFront'][0];
            const frontName = `kyc_${userId}_front_${Date.now()}.png`;
            const { data } = await supabase.storage.from('screenshots').upload(frontName, frontFile.buffer, { contentType: frontFile.mimetype });
            const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(frontName);
            frontUrl = urlData.publicUrl;
        }

        // 2. Upload Aadhar Back
        if (req.files['aadharBack']) {
            const backFile = req.files['aadharBack'][0];
            const backName = `kyc_${userId}_back_${Date.now()}.png`;
            const { data } = await supabase.storage.from('screenshots').upload(backName, backFile.buffer, { contentType: backFile.mimetype });
            const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(backName);
            backUrl = urlData.publicUrl;
        }

        // 3. Update Database
        await pool.query(`
            UPDATE users SET 
                bank_account_no = $1, 
                ifsc_code = $2, 
                upi_id = $3, 
                whatsapp_no = $4,
                aadhar_front_url = $5,
                aadhar_back_url = $6,
                kyc_status = 'pending'
            WHERE id = $7`, 
            [bankAcc, ifsc, upiId, whatsapp, frontUrl, backUrl, userId]
        );

        res.json({ success: true, message: "KYC details and Aadhar submitted!" });
    } catch (err) {
        console.error("KYC Error:", err.message);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});



// 5. Withdrawals
app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. User ka balance check karein (earning_balance se withdraw hoga)
        const userRes = await client.query('SELECT earning_balance FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];

        if (!user || parseFloat(user.earning_balance) < parseFloat(amount)) {
            throw new Error("Insufficient Winning Balance!");
        }

        // 2. Earning balance se amount minus karein
        await client.query(
            'UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2',
            [amount, userId]
        );

        // 3. Transactions table mein entry karein (Kyuki withdrawals table ab nahi hai)
        await client.query(
            `INSERT INTO transactions (user_id, amount, type, status, created_at) 
             VALUES ($1, $2, 'withdrawal', 'pending', NOW())`,
            [userId, amount]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Withdrawal request submitted successfully!" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Withdraw Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
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
// Is query ko server.js mein update karein
app.get('/api/admin/battles/pending-details', async (req, res) => {
    try {
        const query = `
            SELECT b.*, u1.username as creator_name, u2.username as joiner_name 
            FROM battles b
            JOIN users u1 ON b.creator_id = u1.id
            LEFT JOIN users u2 ON b.joiner_id = u2.id
            WHERE b.status = 'pending_approval' 
            ORDER BY b.created_at DESC`;
            
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});


app.get('/api/admin/master-stats', async (req, res) => {
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const kyc = await pool.query("SELECT COUNT(*) FROM users WHERE kyc_status = 'pending'");
        
        // FIX: Ab hum 'transactions' table se withdrawal count nikalenge
        const withdraw = await pool.query("SELECT COUNT(*) FROM transactions WHERE type = 'withdrawal' AND status = 'pending'");
        
        const battles = await pool.query("SELECT COUNT(*) FROM battles WHERE status = 'pending_approval'");

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

app.post('/api/admin/battles/verify-winner', async (req, res) => {
    const { battleId, winnerId } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Battle details aur amount nikalna
        const battleRes = await client.query('SELECT amount, status FROM battles WHERE id = $1', [battleId]);
        const battle = battleRes.rows[0];

        if (!battle || battle.status === 'completed') {
            throw new Error("Battle pehle hi complete ho chuki hai!");
        }

        // 2. Winning Amount Calculate karna (Platform fee kaat kar, eg: 10%)
        // Agar aapne koi fee nahi rakhi toh direct battle.amount use karein
        const winAmount = parseFloat(battle.amount) * 1.8; // Example: ₹100 ki battle par ₹180 milenge

        // 3. Winner ke EARNING_BALANCE mein paisa add karna (Wallet mein nahi)
        await client.query(
            'UPDATE users SET earning_balance = earning_balance + $1 WHERE id = $2',
            [winAmount, winnerId]
        );

        // 4. Battle status update karna
        await client.query(
            'UPDATE battles SET status = $1, winner_id = $2 WHERE id = $3',
            ['completed', winnerId, battleId]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Winner Approved! Paisa Earning Balance mein bhej diya gaya hai." });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Verification Error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/admin/pending-users', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM users WHERE kyc_status = 'pending' ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/approve-user', async (req, res) => {
    const { userId } = req.body;
    try {
        await pool.query("UPDATE users SET is_verified = true, kyc_status = 'approved' WHERE id = $1", [userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users/list', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, username, mobile_no, wallet_balance, is_verified FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// 1. KYC Approve Route
app.post('/api/admin/approve-kyc', async (req, res) => {
    const { userId } = req.body;
    const client = await pool.connect();

    try {
        await client.begin();

        // 1. User ka KYC status 'approved' update karein
        await client.query("UPDATE users SET kyc_status = 'approved' WHERE id = $1", [userId]);

        // 2. Check karein ki kya ye user kisi ke referral se aaya hai
        const userRes = await client.query("SELECT referred_by FROM users WHERE id = $1", [userId]);
        const referredBy = userRes.rows[0]?.referred_by;

        if (referredBy) {
            // 3. Refer karne waale user ko ₹10 ka referral bonus dein (Earning Balance mein)
            await client.query(
                "UPDATE users SET earning_balance = earning_balance + 10 WHERE id = $1",
                [referredBy]
            );

            // 4. Refer karne waale ki transactions history mein entry karein
            await client.query(
                `INSERT INTO transactions (user_id, amount, type, status, created_at) 
                 VALUES ($1, 10, 'referral_bonus', 'success', NOW())`,
                [referredBy]
            );
        }

        await client.commit();
        res.json({ success: true, message: "User approved and referral bonus processed!" });

    } catch (err) {
        await client.rollback();
        console.error("KYC Approval Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// 2. KYC Reject Route
app.post('/api/admin/reject-kyc', async (req, res) => {
    const { userId, reason } = req.body;
    try {
        // KYC status ko 'rejected' set karein
        await pool.query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [userId]);
        res.json({ success: true, message: "User rejected" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 1. Pending Withdrawals Fetch karna
app.get('/api/admin/withdrawals/pending', async (req, res) => {
    try {
        // Hum transactions aur users table ko join kar rahe hain taaki bank/UPI details mil sakein
        const result = await pool.query(`
            SELECT 
                t.id, 
                t.amount, 
                t.status, 
                t.created_at, 
                u.username, 
                u.mobile_no, 
                u.upi_id,
                u.bank_account_no,
                u.ifsc_code
            FROM transactions t
            JOIN users u ON t.user_id = u.id 
            WHERE t.type = 'withdrawal' AND t.status = 'pending'
            ORDER BY t.created_at DESC`);
            
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Withdrawals Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. Withdrawal Approve karna
app.post('/api/admin/withdrawals/approve', async (req, res) => {
    const { withdrawId } = req.body;
    try {
        // 1. Transaction status update
        const result = await pool.query(
            "UPDATE transactions SET status = 'success' WHERE id = $1 RETURNING *", 
            [withdrawId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Transaction nahi mili" });
        }

        res.json({ success: true, message: "Withdrawal Approved successfully!" });
    } catch (err) {
        console.error("Approve Error:", err.message);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});


app.post('/api/admin/withdrawals/reject', async (req, res) => {
    const { withdrawId, reason } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Transaction details nikalna
        const transRes = await client.query("SELECT user_id, amount FROM transactions WHERE id = $1 AND status = 'pending'", [withdrawId]);
        if (transRes.rows.length === 0) throw new Error("Transaction nahi mili");
        
        const { user_id, amount } = transRes.rows[0];

        // 2. User ke earning_balance mein paisa wapis dalna
        await client.query("UPDATE users SET earning_balance = earning_balance + $1 WHERE id = $2", [amount, user_id]);

        // 3. Transaction status update karna
        await client.query("UPDATE transactions SET status = 'rejected' WHERE id = $1", [withdrawId]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});


// --- NEW: Fetch User Referral History ---
// --- 1. Fetch User Referral History ---
app.get('/api/user/referrals/:userId', async (req, res) => {
    const { userId } = req.params;
    
    // Fallback parsing checks
    const targetId = parseInt(userId);
    if (!targetId || isNaN(targetId)) {
        console.error("Critical: Invalid or missing userId passed to referrals:", userId);
        return res.status(400).json({ success: false, error: "Invalid User ID parameter" });
    }

    try {
        console.log(`Executing safe query for referred_by ID: ${targetId}`);
        
        // Ensure standard clean SQL parameters
        const result = await pool.query(`
            SELECT id, username, kyc_status, created_at 
            FROM users 
            WHERE referred_by = $1 
            ORDER BY created_at DESC`, 
            [targetId]
        );
        
        console.log(`Query successful. Found ${result.rows.length} referral rows.`);
        
        // Send safe headers manually to prevent gateway blockages
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Render Query Crash Error:", err.message);
        res.status(500).json({ success: false, error: "Database transaction failed", details: err.message });
    }
});


// 1. Admin se Notification Send karne ka Route
app.post('/api/admin/notifications/add', async (req, res) => {
    const { title, message } = req.body;
    if (!title || !message) {
        return res.status(400).json({ success: false, error: "Title aur Message zaroori hain!" });
    }
    try {
        await pool.query(
            "INSERT INTO notifications (title, message, created_at) VALUES ($1, $2, NOW())",
            [title, message]
        );
        res.json({ success: true, message: "Notification sent successfully!" });
    } catch (err) {
        console.error("Notification Add Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. Users ke liye Notification Fetch karne ka Route
app.get('/api/notifications', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM notifications ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) {
        console.error("Notification Fetch Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});


// Admin se Notification Delete karne ka Route
app.delete('/api/admin/notifications/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query("DELETE FROM notifications WHERE id = $1 RETURNING *", [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Notification nahi mila!" });
        }
        
        res.json({ success: true, message: "Notification deleted successfully!" });
    } catch (err) {
        console.error("Notification Delete Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});


// 1. Get All Users with CORRECT columns for Admin Panel
// Get All Users with Absolute Image URLs for GitHub Pages Compatibility
app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, username, mobile_no, wallet_balance, 
                   COALESCE(kyc_status, 'pending') as kyc_status, 
                   aadhar_front_url, aadhar_back_url, created_at 
            FROM users 
            ORDER BY id DESC
        `);

        // Render Server URL config mapping
        const SERVER_URL = "https://khel-bhai-luso-backend-service.onrender.com";

        // Har row ke image path ko filter karke absolute URL mein convert karein
        const formattedUsers = result.rows.map(user => {
            let front = user.aadhar_front_url ? user.aadhar_front_url.trim() : '';
            let back = user.aadhar_back_url ? user.aadhar_back_url.trim() : '';

            // Agar path dynamic backend upload se hai (/uploads/...) toh full URL jodien
            if (front && front.startsWith('/uploads')) front = `${SERVER_URL}${front}`;
            if (back && back.startsWith('/uploads')) back = `${SERVER_URL}${back}`;

            return {
                ...user,
                aadhar_front_url: front,
                aadhar_back_url: back
            };
        });
        
        res.status(200).json(formattedUsers);
    } catch (err) {
        console.error("Admin Users Fetch Error:", err.message);
        res.status(500).json([]); 
    }
});

// 2. Route to Update KYC Status (Approve/Reject)
app.post('/api/admin/user/update-kyc', async (req, res) => {
    const { userId, status } = req.body; // status can be 'approved' or 'rejected'
    if (!userId || !status) {
        return res.status(400).json({ success: false, error: "Missing parameters" });
    }
    try {
        await pool.query("UPDATE users SET kyc_status = $1 WHERE id = $2", [status, userId]);
        res.status(200).json({ success: true, message: `User KYC status updated to ${status}` });
    } catch (err) {
        console.error("KYC Update Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Route to Delete a User Request / Account completely
app.delete('/api/admin/user/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING *", [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "User nahi mila!" });
        }
        res.status(200).json({ success: true, message: "User requested account deleted successfully!" });
    } catch (err) {
        console.error("User Delete Error:", err.message);
        res.status(500).json({ success: false, error: "Failed to delete user structure" });
    }
});



const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
