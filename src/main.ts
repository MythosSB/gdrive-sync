import { Notice, Plugin } from "obsidian";
import {
	AuthExpiredError,
	pollForToken,
	refreshAccessToken,
	requestDeviceCode,
} from "./auth";
import { registerSyncCommands } from "./commands";
import { DeviceCodeModal } from "./device-code-modal";
import { DriveClient, textToArrayBuffer } from "./drive";
import type { SyncScheduler } from "./scheduler";
import {
	DEFAULT_SETTINGS,
	GDriveSyncSettings,
	GDriveSyncSettingTab,
} from "./settings";

export default class GDriveSyncPlugin extends Plugin {
	settings: GDriveSyncSettings = { ...DEFAULT_SETTINGS };
	drive = new DriveClient(() => this.getAccessToken());
	scheduler: SyncScheduler | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new GDriveSyncSettingTab(this.app, this));
				registerSyncCommands(this);

		this.addCommand({
			id: "test-google-connection",
			name: "Test Google connection",
			callback: async () => {
				try {
					await this.getAccessToken();
					const minutes = Math.round(
						(this.settings.accessTokenExpiry - Date.now()) / 60000
					);
					new Notice(`Conexión correcta. El acceso dura ${minutes} min más.`);
				} catch (error) {
					new Notice(error instanceof Error ? error.message : String(error));
				}
			},
		});

		this.addCommand({
			id: "test-drive-upload",
			name: "Test Drive upload",
			callback: async () => {
				try {
					const folderName =
						this.settings.driveFolderName || this.app.vault.getName();
					const rootId = await this.drive.ensureFolder(folderName);
					const subId = await this.drive.ensureFolderPath("Pruebas/2026", rootId);

					// 1. Subir (o actualizar si ya existe) un archivo de prueba
					const text = `Prueba de GDrive Sync\n${new Date().toISOString()}\nacentos: áéíóú ñ\n`;
					const existing = (await this.drive.listFiles(subId)).find(
						(f) => f.name === "prueba.txt"
					);
					const file = existing
						? await this.drive.updateFile(existing.id, textToArrayBuffer(text), "text/plain")
						: await this.drive.uploadFile("prueba.txt", subId, textToArrayBuffer(text), "text/plain");

					// 2. Descargarlo y comprobar que es idéntico
					const back = new TextDecoder().decode(await this.drive.downloadFile(file.id));
					if (back !== text) throw new Error("El contenido descargado no coincide");

					new Notice(
						`Drive OK: ${folderName}/Pruebas/2026/prueba.txt (${existing ? "actualizado" : "creado"})`
					);
				} catch (error) {
					console.error(error);
					new Notice(error instanceof Error ? error.message : String(error));
				}
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Inicia el login con Google (device flow).
	async connect(): Promise<void> {
		const { clientId, clientSecret } = this.settings;
		if (!clientId || !clientSecret) {
			new Notice("Primero pega el Client ID y el Client secret en los ajustes.");
			return;
		}

		let modal: DeviceCodeModal | null = null;
		try {
			const device = await requestDeviceCode(clientId);

			modal = new DeviceCodeModal(
				this.app,
				device.user_code,
				device.verification_url
			);
			modal.open();
			const openedModal = modal;

			const token = await pollForToken(
				clientId,
				clientSecret,
				device,
				() => openedModal.cancelled
			);

			if (!token.refresh_token) {
				throw new Error("Google no devolvió un refresh token. Intenta de nuevo.");
			}

			this.settings.refreshToken = token.refresh_token;
			this.settings.accessToken = token.access_token;
			this.settings.accessTokenExpiry = Date.now() + token.expires_in * 1000;
			await this.saveSettings();

			modal.close();
			new Notice("Conectado con Google correctamente.");
		} catch (error) {
			modal?.close();
			new Notice(error instanceof Error ? error.message : String(error));
		}
	}

	// Borra la sesión guardada.
	async disconnect(): Promise<void> {
		this.settings.refreshToken = "";
		this.settings.accessToken = "";
		this.settings.accessTokenExpiry = 0;
		await this.saveSettings();
		new Notice("Desconectado de Google.");
	}

	// Devuelve un access token válido, renovándolo si está por caducar.
	async getAccessToken(): Promise<string> {
		const s = this.settings;
		if (!s.refreshToken) {
			throw new Error("No has conectado Google. Pulsa Connect en los ajustes.");
		}

		// Si aún le queda más de 1 minuto de vida, lo reutilizamos.
		if (s.accessToken && Date.now() < s.accessTokenExpiry - 60_000) {
			return s.accessToken;
		}

		try {
			const token = await refreshAccessToken(
				s.clientId,
				s.clientSecret,
				s.refreshToken
			);
			s.accessToken = token.access_token;
			s.accessTokenExpiry = Date.now() + token.expires_in * 1000;
			await this.saveSettings();
			return s.accessToken;
		} catch (error) {
			if (error instanceof AuthExpiredError) {
				s.refreshToken = "";
				s.accessToken = "";
				s.accessTokenExpiry = 0;
				await this.saveSettings();
				new Notice(
					"La sesión con Google caducó. Pulsa Connect en los ajustes para volver a iniciar sesión."
				);
			}
			throw error;
		}
	}
}