console.log('GROQ_SMOKE:', process.env.POCKETCODE_RUN_LIVE_GROQ_SMOKE);
console.log('AGENT_SMOKE:', process.env.POCKETCODE_ENABLE_AGENT_SMOKE);
console.log('USER_ID:', process.env.POCKETCODE_SMOKE_USER_ID);
console.log('TOKEN_KEY:', process.env.TOKEN_ENCRYPTION_KEY);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('KEY_LEN:', process.env.TOKEN_ENCRYPTION_KEY?.length);
console.log('KEY_MATCH:', /^[\da-fA-F]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY || ''));