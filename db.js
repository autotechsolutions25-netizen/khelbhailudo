const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Cloud (Supabase) ke liye ye sabse zaroori hai
    }
});

module.exports = pool;
