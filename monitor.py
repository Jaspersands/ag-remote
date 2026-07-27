import os
import sys
import time
import subprocess

def is_ag_running():
    res = subprocess.run(["/bin/ps", "aux", "-ww"], capture_output=True, text=True)
    for line in res.stdout.split('\n'):
        # Check for the main Antigravity process
        if "/Applications/Antigravity.app/Contents/MacOS/Antigravity" in line and "grep" not in line:
            return True
    return False

def is_server_running():
    res = subprocess.run(["/bin/ps", "aux", "-ww"], capture_output=True, text=True)
    for line in res.stdout.split('\n'):
        # Check for our server
        if " server.py" in line and "grep" not in line and "monitor.py" not in line:
            return True
    return False

if __name__ == "__main__":
    print("AG-Remote Monitor started. Waiting for Antigravity...", flush=True)
    while True:
        try:
            ag_up = is_ag_running()
            server_up = is_server_running()
            
            if ag_up and not server_up:
                print("Antigravity is open. Starting AG-Remote server...", flush=True)
                # Start the server in the background
                env = os.environ.copy()
                env["PYTHONUNBUFFERED"] = "1"
                BASE_DIR = os.path.dirname(os.path.abspath(__file__))
                subprocess.Popen(
                    [sys.executable, "server.py"], 
                    cwd=BASE_DIR,
                    env=env
                )
            elif not ag_up and server_up:
                print("Antigravity is closed. Stopping AG-Remote server...", flush=True)
                subprocess.run(["/usr/bin/pkill", "-f", "server.py"])
                subprocess.run(["/usr/bin/killall", "cloudflared"])
                
        except Exception as e:
            print(f"Error in monitor: {e}", flush=True)
            
        time.sleep(30)
