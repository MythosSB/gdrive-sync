import { App, PluginSettingTab, Setting } from "obsidian";
import type GDriveSyncPlugin from "./main";

export interface GDriveSyncSettings {
	clientId: string;
	clientSecret: string;
	driveFolderName: string;
	refreshToken: string;
	accessToken: string;
	accessTokenExpiry: number; // momento (ms) en que caduca el access token
}

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
	clientId: "",
	clientSecret: "",
	driveFolderName: "",
	refreshToken: "",
	accessToken: "",
	accessTokenExpiry: 0,
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
	}
}