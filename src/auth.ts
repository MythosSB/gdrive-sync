import { requestUrl } from "obsidian";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Permiso mínimo: solo los archivos que crea este plugin.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_url: string;
	expires_in: number;
	interval: number;
}

export interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
}

// Se lanza cuando Google ya no acepta el refresh token (caducó o fue revocado).
export class AuthExpiredError extends Error {
	constructor() {
		super("La sesión con Google caducó");
		this.name = "AuthExpiredError";
	}
}

interface FormResult {
	status: number;
	json: Record<string, unknown>;
}

// Envía un formulario (POST) y devuelve el estado HTTP y el JSON de respuesta.
async function postForm(
	url: string,
	params: Record<string, string>
): Promise<FormResult> {
	const res = await requestUrl({
		url,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(params).toString(),
		throw: false, // así podemos leer los errores de Google nosotros mismos
	});

	let json: Record<string, unknown> = {};
	try {
		json = res.json as Record<string, unknown>;
	} catch {
		// la respuesta no era JSON; dejamos el objeto vacío
	}
	return { status: res.status, json };
}

function errorText(result: FormResult): string {
	const description = result.json["error_description"];
	const code = result.json["error"];
	if (typeof description === "string") return description;
	if (typeof code === "string") return code;
	return `HTTP ${result.status}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Paso 1: pedir a Google un código para que el usuario lo escriba en el navegador.
export async function requestDeviceCode(
	clientId: string
): Promise<DeviceCodeResponse> {
	const result = await postForm(DEVICE_CODE_URL, {
		client_id: clientId,
		scope: DRIVE_SCOPE,
	});
	if (result.status !== 200) {
		throw new Error(`No se pudo iniciar el login: ${errorText(result)}`);
	}
	return result.json as unknown as DeviceCodeResponse;
}

// Paso 2: preguntar a Google cada pocos segundos si el usuario ya autorizó.
export async function pollForToken(
	clientId: string,
	clientSecret: string,
	device: DeviceCodeResponse,
	isCancelled: () => boolean
): Promise<TokenResponse> {
	let interval = device.interval || 5;
	const deadline = Date.now() + device.expires_in * 1000;

	while (Date.now() < deadline) {
		await sleep(interval * 1000);
		if (isCancelled()) throw new Error("Login cancelado");

		const result = await postForm(TOKEN_URL, {
			client_id: clientId,
			client_secret: clientSecret,
			device_code: device.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});

		if (result.status === 200) {
			return result.json as unknown as TokenResponse;
		}

		const code = result.json["error"];
		if (code === "authorization_pending") continue; // aún no autoriza
		if (code === "slow_down") {
			interval += 5; // Google pide ir más despacio
			continue;
		}
		if (code === "access_denied") {
			throw new Error("Rechazaste el acceso en Google");
		}
		throw new Error(`Error de login: ${errorText(result)}`);
	}
	throw new Error("El código expiró. Vuelve a pulsar Connect");
}

// Cambia el refresh token por un access token nuevo (dura ~1 hora).
export async function refreshAccessToken(
	clientId: string,
	clientSecret: string,
	refreshToken: string
): Promise<TokenResponse> {
	const result = await postForm(TOKEN_URL, {
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	});

	if (result.status === 200) {
		return result.json as unknown as TokenResponse;
	}
	if (result.json["error"] === "invalid_grant") {
		throw new AuthExpiredError();
	}
	throw new Error(`No se pudo renovar el acceso: ${errorText(result)}`);
}