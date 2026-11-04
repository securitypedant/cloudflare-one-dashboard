-- WARP device samples per hour by the user's ISP location (Cloudflare IP geolocation from
-- dex_device_state_events) and the data center the client connects to. No IPs or device IDs stored.
CREATE TABLE user_location_hourly (
	hour INTEGER NOT NULL,
	country TEXT NOT NULL,
	state TEXT NOT NULL,
	city TEXT NOT NULL,
	isp TEXT NOT NULL,
	colo TEXT NOT NULL,
	samples INTEGER NOT NULL,
	lat_n INTEGER NOT NULL,   -- samples with a handshake latency (WARP connected)
	lat_total REAL NOT NULL,  -- sum of handshake latency (ms)
	PRIMARY KEY (hour, country, state, city, isp, colo)
) WITHOUT ROWID;
