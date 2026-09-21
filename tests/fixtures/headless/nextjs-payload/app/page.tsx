'use client';
// VULN: client-side bundle embeds a privileged CMS token
export const CMS_ADMIN_TOKEN = process.env.NEXT_PUBLIC_PAYLOAD_API_KEY;
export const CMS_ENDPOINT = 'https://payload.example/rest';
export default function Page(){ return <div data-token={CMS_ADMIN_TOKEN}>leak</div>; }
