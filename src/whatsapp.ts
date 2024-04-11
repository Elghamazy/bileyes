import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import pino from "pino";
import path from "path";
import * as fs from "fs";
import { Boom } from "@hapi/boom";
import signale from "signale";
import * as os from "os";
import mime from "mime";
import axios from "axios";

export const globalOptions = {
	logLevel: "silent",
};


export function getAuthStateCacheFolderLocation() {
	if (process.env.BILEYES_CACHE_FOLDER) {
		return process.env.BILEYES_CACHE_FOLDER;
	} else {
		const homedir = os.homedir();
		if (process.platform === "win32") {
			return path.join(homedir, "AppData", "Local", "bileyes", "Data");
		} else {
			return path.join(homedir, ".local", "share", "bileyes");
		}
	}
}

function clearCacheFolder() {
	const folder = initAuthStateCacheFolder();
	fs.readdirSync(folder).forEach((f) => f.endsWith(".json") && fs.rmSync(`${folder}/${f}`));
}

function initAuthStateCacheFolder() {
	const folderLocation = getAuthStateCacheFolderLocation();
	if (!fs.existsSync(folderLocation)) {
		fs.mkdirSync(folderLocation, { recursive: true });
		signale.log(`Created bileyes cache folder: ${folderLocation}`);
	}
	return folderLocation;
}

export async function initWASocket(printQR = true, message: string | undefined = undefined) {
	const { state, saveCreds } = await useMultiFileAuthState(initAuthStateCacheFolder());
	const os = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

	const socket = makeWASocket({
		logger: pino({ level: globalOptions.logLevel }),
		auth: state,
		browser: [os, "Chrome", "10.15.0"],

		getMessage: async (_) => {
			return {
				conversation: message,
			};
		},
	});

	socket.ev.on("connection.update", async (connectionState) => {
        if (connectionState.qr) {
            const qrLink = await generateQRImg(connectionState.qr);
            console.log(`QR Image: ${qrLink}`);
        }
    });

	socket.ev.on("creds.update", async () => await saveCreds());
	return socket;
}

async function generateQRImg(qr: string) {
    const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?color=000000&bgcolor=FFFFFF&data=${encodeURIComponent(
        qr,
    )}&qzone=1&margin=0&size=400x400&ecc=L`;

    try {
        const { data } = await axios.post(
            "https://spoo.me/",
            {
                url: qrImgUrl,
            },
            {
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                },
            },
        );

        const shortenedUrl = (data as any).short_url;
        return shortenedUrl;
    } catch (error) {
        console.log("Failed to shorten the url", error);

        return qrImgUrl;
    }
}

export function terminate(socket: any, waitSeconds = 1) {
	if (waitSeconds > 0) {
		signale.await(`Closing WA connection, waiting for ${waitSeconds} second(s)...`);
	}
	setTimeout(() => {
		socket.end(undefined);
		socket.ws.close();
		process.exit();
	}, waitSeconds * 1000);
}

export function checkLoggedIn() {
	if (!fs.existsSync(path.join(initAuthStateCacheFolder(), "creds.json"))) {
		signale.error("Not logged in");
		process.exit(1);
	}
}

export function checkValidFile(path: string) {
	if (!(fs.existsSync(path) && fs.lstatSync(path).isFile())) {
		signale.error(`Could not read image file: ${path}`);
		process.exit(1);
	}
}

export function parseGeoLocation(latitude: string, longitude: string): Array<number> {
	const latitudeFloat = parseFloat(latitude);
	const longitudeFloat = parseFloat(longitude);
	if (isNaN(latitudeFloat) || isNaN(longitudeFloat)) {
		signale.error(`Invalid geo location: ${latitude}, ${longitude}`);
		process.exit(1);
	}
	return [parseFloat(latitudeFloat.toFixed(7)), parseFloat(longitudeFloat.toFixed(7))];
}

export async function waitForKey(message: string) {
	signale.pause(message);
	process.stdin.setRawMode(true);
	return new Promise((resolve) =>
		process.stdin.once("data", () => {
			process.stdin.setRawMode(false);
			resolve(undefined);
		}),
	);
}

export async function login(waitForWA = false) {
	if (!waitForWA) {
		signale.info('In the WhatsApp mobile app go to "Settings > Connected Devices > ');
		signale.info('Connect Device" and scan the QR code below');
	}
	const socket = await initWASocket();
	socket.ev.on("connection.update", async (update) => {
		const { connection, lastDisconnect } = update;
		if (connection === "close") {
			if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
				await login(true);
			} else {
				return;
			}
		} else if (connection === "open") {
			signale.success("Logged in");
			if (waitForWA) {
				await waitForKey("Wait until WhatsApp finishes connecting, then press any key to exit");
				terminate(socket);
			} else {
				terminate(socket);
			}
		}
	});
}

export async function logout() {
	checkLoggedIn();
	const socket = await initWASocket(false);
	socket.ev.on("connection.update", async (update) => {
		const { connection } = update;
		if (update.connection === undefined && update.qr) {
			clearCacheFolder();
			signale.success(`Logged out`);
			terminate(socket);
		}
		if (connection === "open") {
			await socket.logout();
			clearCacheFolder();
			signale.success(`Logged out`);
			terminate(socket);
		}
	});
	process.on("exit", clearCacheFolder);
}

export async function getWhatsAppId(socket: any, recipient: string) {
	if (recipient.startsWith("+")) {
		recipient = recipient.substring(1);
	}
	if (recipient.endsWith("@s.whatsapp.net") || recipient.endsWith("@g.us")) {
		return recipient;
	} else if (recipient === "me") {
		const user = await socket.user;
		if (user) {
			const phoneNumber = user.id.substring(0, user.id.indexOf(":"));
			return `${phoneNumber}@s.whatsapp.net`;
		}
	}
	return `${recipient}@s.whatsapp.net`;
}

export async function sendImageHelper(
	socket: any,
	whatsappId: string,
	filePath: string,
	options: {
		caption: string | undefined;
	},
) {
	const payload = { image: fs.readFileSync(filePath), caption: handleNewlines(options.caption) };
	await socket.sendMessage(whatsappId, payload);
	signale.success("Done");
	terminate(socket, 3);
}

export async function sendFileHelper(
	socket: any,
	whatsappId: string,
	filePath: string,
	options: { caption: string | undefined; type: "audio" | "video" | "document" },
) {
	const payload: any = {
		mimetype: mime.getType(filePath),
		caption: handleNewlines(options.caption),
	};
	switch (options.type) {
		case "audio":
			payload["audio"] = fs.readFileSync(filePath);
			break;
		case "video":
			payload["video"] = fs.readFileSync(filePath);
			break;
		default:
			payload["document"] = fs.readFileSync(filePath);
			payload["fileName"] = path.basename(filePath);
	}
	await socket.sendMessage(whatsappId, payload);
	signale.success("Done");
	terminate(socket, 3);
}

export function handleNewlines(s?: string): string | undefined {
	if (s) {
		return s.replace(/\\n/g, "\n");
	}
}
