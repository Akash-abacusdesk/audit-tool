import "server-only";
// SAFE: server-only credential, never shipped to client
const secret = process.env.DIRECTUS_ADMIN_TOKEN;
export async function fetchCms(){ return fetch('https://cms.example/rest', {headers:{Authorization: 'Bearer ' + secret}}); }
