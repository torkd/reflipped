# Deploying Reflipped

## DISCLAIMER

**While these scripts exist to facilitate ease of deployment, they are not a one-size-fits-all solution and may not work if not properly configured.**

**THESE FILES ARE PROVIDED FOR PERSONAL USE AND NOT DESIGNED FOR CREATING PUBLICLY-AVAILABLE SERVICES. CREATING AND SERVING A PUBLICLY-AVAILABLE SERVER IS HIGHLY DISCOURAGED, ESPECIALLY WITH THESE FILES AS PROVIDED. NO AUTHOR NOR CONTRIBUTOR TO REFLIPPED ENDORSES NOR ASSUMES RESPONSIBILITY OF ANY KIND FOR ANY CONSEQUENCES OF ANY KIND SHOULD ONE ATTEMPT TO MAKE AVAILABLE ANY SERVICES USING THIS REPOSITORY. BY RUNNING ANY PART OF THIS CODE, AN INDIVIDUAL AGREES TO RELEASE REFLIPPED AND ITS CONTRIBUTORS OF ALL LIABILITY. VOLUNTARY ASSISTANCE WITH LOCAL SETUPS SHALL NOT BE CONSIDERED LIABILITY, NOR ENDORSEMENT.**

## Which guide?
- **Docker** (recommended): the [Docker guide](../docker/README.md), and the step-by-step [public server guide](../docs/deployment.md).
- **Straight on a Linux machine**, without Docker: [public server guide](../docs/deployment.md), "Without Docker: systemd".

## What is in this folder
Files for running Reflipped directly on a Linux machine:
- `linux/reflipped.service`: a system service that runs Reflipped locked down, plus `reflipped-backup.service` and `reflipped-backup.timer` for a daily backup.
- `linux/install_reflipped.sh`: an installer for the older setup where the original game app is pointed at Reflipped through DNS (a fallback; players normally use the rebuilt app).
- `linux/dns/`: dnsmasq settings for that DNS setup.
- `nginx/`: an nginx config that sits in front of Reflipped.
- `ssl/`: scripts that make a self-signed certificate, for Linux, macOS and Windows (they need OpenSSL). On Linux they install it where the nginx config expects it.
- `reflipped_script_setup_env.sh`: helper functions the other scripts use.

Build Reflipped (`npm ci`) on the machine that will run it: copying a build from another machine may not work.

Make sure `LISTEN_HOST` in `.env` is set to an address other machines can reach, not `localhost`.
