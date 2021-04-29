/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SqlOpsDataClient, ClientOptions, SqlOpsFeature, ISqlOpsFeature } from 'dataprotocol-client';
import { IConfig, ServerProvider } from 'service-downloader';
import { ServerOptions, RPCMessageType, ClientCapabilities, ServerCapabilities, TransportKind } from 'vscode-languageclient';
import { Disposable, SecretStorage } from 'vscode';
import * as UUID from 'vscode-languageclient/lib/utils/uuid';
import * as azdata from 'azdata';
import * as mssql from '../mssql';
import * as Contracts from './contracts';
import * as Constants from './constants';
import * as Utils from '../utils';
import { AppContext } from '../appContext';

export class SecretStoreService implements mssql.ISecretStoreService {

	private static readonly messagesTypes: RPCMessageType[] = [
		Contracts.DeleteCredentialRequest.type,
		Contracts.SaveCredentialRequest.type,
		Contracts.ReadCredentialRequest.type
	];

	private constructor(context: AppContext, protected readonly client: SqlOpsDataClient) {
		super(client, SecretStoreService.messagesTypes);
		context.registerService("SecretStoreService", this);
	}

	public static asFeature(context: AppContext): ISqlOpsFeature {
		return class extends SecretStoreService {
			private _secretStore: SecretStorage;
			constructor(client: SqlOpsDataClient) {
				super(context, client);
				this._secretStore = context.extensionContext.secrets;
			}

			fillClientCapabilities(capabilities: ClientCapabilities): void {
				Utils.ensure(Utils.ensure(capabilities, 'credentials')!, 'credentials')!.dynamicRegistration = true;
			}

			initialize(): void {
				this.register(this.messages, {
					id: UUID.generateUuid(),
					registerOptions: undefined
				});
			}

			protected registerProvider(options: any): Disposable {

				let readCredential = async (credentialId: string): Promise<azdata.Credential> => {
					const password = await this._secretStore.get(credentialId);
					if (password) {
						const credential: azdata.Credential = {
							credentialId: credentialId,
							password: password
						};
						return credential;
					}
					return undefined;
				};

				let saveCredential = async (credentialId: string, password: string): Promise<boolean> => {
					// save password
					await this._secretStore.store(credentialId, password);
					// check if saved
					const savedPassword = await this._secretStore.get(credentialId);
					return password === savedPassword;
				};

				let deleteCredential = async (credentialId: string): Promise<boolean> => {
					// delete password
					await this._secretStore.delete(credentialId);
					// check if deleted
					return await this._secretStore.get(credentialId) === undefined;
				};

				return azdata.credentials.registerProvider({
					deleteCredential,
					readCredential,
					saveCredential,
					handle: 0
				});
			}
		};

	}
}

class CredentialsFeature extends SqlOpsFeature<any> {

	private static readonly messagesTypes: RPCMessageType[] = [
		Contracts.DeleteCredentialRequest.type,
		Contracts.SaveCredentialRequest.type,
		Contracts.ReadCredentialRequest.type
	];

	constructor(client: SqlOpsDataClient) {
		super(client, CredentialsFeature.messagesTypes);
	}

	fillClientCapabilities(capabilities: ClientCapabilities): void {
		Utils.ensure(Utils.ensure(capabilities, 'credentials')!, 'credentials')!.dynamicRegistration = true;
	}

	initialize(capabilities: ServerCapabilities): void {
		this.register(this.messages, {
			id: UUID.generateUuid(),
			registerOptions: undefined
		});
	}

	protected registerProvider(options: any): Disposable {
		const client = this._client;

		let readCredential = (credentialId: string): Thenable<azdata.Credential> => {
			return client.sendRequest(Contracts.ReadCredentialRequest.type, { credentialId, password: undefined });
		};

		let saveCredential = (credentialId: string, password: string): Thenable<boolean> => {
			return client.sendRequest(Contracts.SaveCredentialRequest.type, { credentialId, password });
		};

		let deleteCredential = (credentialId: string): Thenable<boolean> => {
			return client.sendRequest(Contracts.DeleteCredentialRequest.type, { credentialId, password: undefined });
		};

		return azdata.credentials.registerProvider({
			deleteCredential,
			readCredential,
			saveCredential,
			handle: 0
		});
	}
}

/**
 * Implements a credential storage for Windows, Mac (darwin), or Linux.
 *
 * Allows a single credential to be stored per service (that is, one username per service);
 */
export class CredentialStore {
	private _client: SqlOpsDataClient;
	private _config: IConfig;

	constructor(private logPath: string, baseConfig: IConfig) {
		if (baseConfig) {
			this._config = JSON.parse(JSON.stringify(baseConfig));
			this._config.executableFiles = ['MicrosoftSqlToolsCredentials.exe', 'MicrosoftSqlToolsCredentials'];
		}
	}

	public start() {
		let serverdownloader = new ServerProvider(this._config);
		let clientOptions: ClientOptions = {
			providerId: Constants.providerId,
			features: [CredentialsFeature]
		};
		return serverdownloader.getOrDownloadServer().then(e => {
			let serverOptions = this.generateServerOptions(e);
			this._client = new SqlOpsDataClient(Constants.serviceName, serverOptions, clientOptions);
			this._client.start();
		});
	}

	dispose() {
		if (this._client) {
			this._client.stop();
		}
	}

	private generateServerOptions(executablePath: string): ServerOptions {
		let launchArgs = Utils.getCommonLaunchArgsAndCleanupOldLogFiles(this.logPath, 'credentialstore.log', executablePath);
		return { command: executablePath, args: launchArgs, transport: TransportKind.stdio };
	}
}
