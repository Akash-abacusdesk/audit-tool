import "server-only";
// SAFE: server-only credential, never shipped to client
const secret = process.env.WP_ADMIN_TOKEN;
export async function fetchCms(){ return fetch('https://cms.example/graphql', {headers:{Authorization: 'Bearer ' + secret}}); }
