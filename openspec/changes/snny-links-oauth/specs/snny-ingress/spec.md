## ADDED Requirements

### Requirement: Dedicated Cloudflare tunnel, independent of devbox
Public exposure of `snny.ai` SHALL use a dedicated named cloudflared tunnel owned by this project — its own tunnel name, credentials file, config file, and systemd user unit — routing `snny.ai` (and `www.snny.ai`) directly to the Sunny Nitro server's local port. The setup SHALL NOT depend on the devbox service, its Caddy router, its registry, or its `devbox` tunnel in any way: Sunny's only host-level dependency for this capability is the `cloudflared` binary and a Cloudflare account holding the `snny.ai` zone. Stopping or reconfiguring devbox SHALL have no effect on `snny.ai` routing.

#### Scenario: devbox outage does not affect snny.ai
- **WHEN** the devbox Caddy and tunnel services are stopped
- **THEN** `https://snny.ai/s/<hash>` and `https://snny.ai/cb/<token>` continue to work

#### Scenario: Tunnel survives reboot
- **WHEN** the host reboots
- **THEN** the snny tunnel's systemd user unit starts automatically (linger already enabled) and `snny.ai` is reachable without manual intervention

### Requirement: Idempotent setup and doctor visibility
The repo SHALL provide an idempotent setup path (script or documented `cloudflared` invocations) that creates the tunnel, writes its config with ingress `snny.ai → http://localhost:<port>`, routes DNS for `snny.ai` via Cloudflare, and installs/enables the systemd user unit — safe to re-run. `npm run doctor` SHALL report the snny ingress health: unit active, and the public `https://snny.ai/health` endpoint responding.

#### Scenario: Re-running setup is safe
- **WHEN** the setup script runs on a host where the tunnel already exists
- **THEN** it converges to the same state without duplicating tunnels, DNS records, or units

#### Scenario: Doctor flags a dead tunnel
- **WHEN** the snny tunnel unit is stopped and doctor runs
- **THEN** doctor reports the snny ingress as unhealthy
