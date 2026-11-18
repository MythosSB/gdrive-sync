import { App, PluginSettingTab, Setting } from "obsidian";
import type GDriveSyncPlugin from "./main";

export interface GDriveSyncSettings {
	clientId: string;
	clientSecret: string;
	driveFolderName: string;
	refreshToken: string;
	accessToken: string;
	accessTokenExpiry: number; // momento (ms) en que caduca el access token
	syncOnOpen: boolean; // sincronizar al abrir Obsidian o volver a la app
	syncIntervalMinutes: number; // 0 = desactivado
	syncOnChange: boolean; // sincronizar poco después de editar
	syncOnChangeDelaySeconds: number; // espera tras el último cambio
	confirmBeforeClose: boolean; // avisar al cerrar con cambios sin sincronizar
	maxFileSizeMB: number; // archivos más grandes se omiten (0 = sin límite)
}

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
	clientId: "",
	clientSecret: "",
	driveFolderName: "",
	refreshToken: "",
	accessToken: "",
	accessTokenExpiry: 0,
	syncOnOpen: true,
	syncIntervalMinutes: 0,
	syncOnChange: false,
	syncOnChangeDelaySeconds: 30,
	confirmBeforeClose: true,
	maxFileSizeMB: 50,
};

export class GDriveSyncSettingTab extends PluginSettingTab {
	plugin: GDriveSyncPlugin;

	constructor(app: App, plugin: GDriveSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("El ID de cliente OAuth de tu proyecto de Google Cloud.")
			.addText((text) =>
				text
					.setPlaceholder("xxxx.apps.googleusercontent.com")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("El secreto del cliente OAuth. Trátalo como una contraseña.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Drive folder name")
			.setDesc("Carpeta de Drive donde se guardará esta bóveda.")
			.addText((text) =>
				text
					.setPlaceholder(this.app.vault.getName())
					.setValue(this.plugin.settings.driveFolderName)
					.onChange(async (value) => {
						this.plugin.settings.driveFolderName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		const connected = this.plugin.settings.refreshToken !== "";

		const connection = new Setting(containerEl)
			.setName("Google account")
			.setDesc(connected ? "Estado: conectado" : "Estado: sin conectar");

		connection.addButton((button) =>
			button
				.setButtonText(connected ? "Reconnect" : "Connect")
				.setCta()
				.onClick(async () => {
					await this.plugin.connect();
					this.display(); // redibuja para actualizar el estado
				})
		);

		if (connected) {
			connection.addButton((button) =>
				button.setButtonText("Disconnect").onClick(async () => {
					await this.plugin.disconnect();
					this.display();
				})
			);
		}

		new Setting(containerEl).setName("Automatic sync").setHeading();

		new Setting(containerEl)
			.setName("Sync when opening Obsidian")
			.setDesc("Sincroniza al abrir Obsidian y al volver a la app (muy útil en el móvil).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnOpen).onChange(async (value) => {
					this.plugin.settings.syncOnOpen = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Periodic sync")
			.setDesc("Cada cuánto sincronizar mientras Obsidian está abierto.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"0": "Off",
						"5": "Every 5 minutes",
						"10": "Every 10 minutes",
						"15": "Every 15 minutes",
						"30": "Every 30 minutes",
						"60": "Every hour",
					})
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						this.plugin.settings.syncIntervalMinutes = Number(value);
						await this.plugin.saveSettings();
						this.plugin.scheduler?.reconfigure();
					})
			);

		new Setting(containerEl)
			.setName("Sync after editing")
			.setDesc("Sincroniza poco después de que dejes de editar.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnChange).onChange(async (value) => {
					this.plugin.settings.syncOnChange = value;
					await this.plugin.saveSettings();
					this.plugin.scheduler?.reconfigure();
				})
			);

		new Setting(containerEl)
			.setName("Wait after last change")
			.setDesc("Tiempo de espera desde tu última edición antes de sincronizar.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"15": "15 seconds",
						"30": "30 seconds",
						"60": "1 minute",
						"120": "2 minutes",
						"300": "5 minutes",
					})
					.setValue(String(this.plugin.settings.syncOnChangeDelaySeconds))
					.onChange(async (value) => {
						this.plugin.settings.syncOnChangeDelaySeconds = Number(value);
						await this.plugin.saveSettings();
					})
			);


		new Setting(containerEl)
			.setName("Ask before closing with unsynced changes")
			.setDesc(
				"En escritorio, muestra un menú al cerrar si hay cambios sin subir. " +
					"En el móvil, intenta sincronizar al salir de la app."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmBeforeClose).onChange(async (value) => {
					this.plugin.settings.confirmBeforeClose = value;
					await this.plugin.saveSettings();
				})
			);
		
		new Setting(containerEl).setName("Limits").setHeading();

		new Setting(containerEl)
			.setName("Maximum file size")
			.setDesc(
				"Los archivos más grandes no se sincronizan (ni se borran). " +
					"Evita que el móvil se quede sin memoria con archivos enormes."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"10": "10 MB",
						"25": "25 MB",
						"50": "50 MB",
						"100": "100 MB",
						"250": "250 MB",
						"0": "No limit",
					})
					.setValue(String(this.plugin.settings.maxFileSizeMB))
					.onChange(async (value) => {
						this.plugin.settings.maxFileSizeMB = Number(value);
						await this.plugin.saveSettings();
					})
			);
	}
}