const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000, // 10 seconds wait karega
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Connection Error:', err.message);
    }
    console.log('✅ Connected to Supabase Successfully!');
    release();
});

module.exports = pool;
