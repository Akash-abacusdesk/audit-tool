Frontend: next
Backend: payload
Transport: rest
Seeded exposure: client bundle leaks NEXT_PUBLIC_PAYLOAD_API_KEY
Expected detections: NEXT_PUBLIC admin-token exposure (generic D3) + payload-specific admin-token rule (D4)
