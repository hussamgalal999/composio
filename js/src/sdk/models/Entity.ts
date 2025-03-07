import { z } from "zod";
import logger from "../../utils/logger";
import { GetConnectionsResponseDto } from "../client";
import {
  ZConnectionParams,
  ZExecuteActionParams,
  ZInitiateConnectionParams,
  ZTriggerSubscribeParam,
} from "../types/entity";
import { ZAuthMode } from "../types/integration";
import { CEG } from "../utils/error";
import { COMPOSIO_SDK_ERROR_CODES } from "../utils/errors/src/constants";
import { TELEMETRY_LOGGER } from "../utils/telemetry";
import { TELEMETRY_EVENTS } from "../utils/telemetry/events";
import { ActionExecuteResponse, Actions } from "./actions";
import { ActiveTriggers } from "./activeTriggers";
import { Apps } from "./apps";
import { BackendClient } from "./backendClient";
import {
  ConnectedAccounts,
  ConnectionItem,
  ConnectionRequest,
} from "./connectedAccounts";
import { Integrations } from "./integrations";
import { Triggers } from "./triggers";

const LABELS = {
  PRIMARY: "primary",
};

// Types from zod schemas
type TriggerSubscribeParam = z.infer<typeof ZTriggerSubscribeParam>;
type ConnectionParams = z.infer<typeof ZConnectionParams>;
type InitiateConnectionParams = z.infer<typeof ZInitiateConnectionParams>;
type ExecuteActionParams = z.infer<typeof ZExecuteActionParams>;

// type from API
export type ConnectedAccountListRes = GetConnectionsResponseDto;

export class Entity {
  id: string;
  private backendClient: BackendClient;
  private triggerModel: Triggers;
  private actionsModel: Actions;
  private apps: Apps;
  private connectedAccounts: ConnectedAccounts;
  private integrations: Integrations;
  private activeTriggers: ActiveTriggers;

  private fileName: string = "js/src/sdk/models/Entity.ts";

  constructor(backendClient: BackendClient, id: string = "default") {
    this.backendClient = backendClient;
    this.id = id;
    this.triggerModel = new Triggers(this.backendClient);
    this.actionsModel = new Actions(this.backendClient);
    this.apps = new Apps(this.backendClient);
    this.connectedAccounts = new ConnectedAccounts(this.backendClient);
    this.integrations = new Integrations(this.backendClient);
    this.activeTriggers = new ActiveTriggers(this.backendClient);
  }

  async execute({
    actionName,
    params,
    text,
    connectedAccountId,
  }: ExecuteActionParams): Promise<ActionExecuteResponse> {
    TELEMETRY_LOGGER.manualTelemetry(TELEMETRY_EVENTS.SDK_METHOD_INVOKED, {
      method: "execute",
      file: this.fileName,
      params: { actionName, params, text, connectedAccountId },
    });
    try {
      ZExecuteActionParams.parse({
        actionName,
        params,
        text,
        connectedAccountId,
      });
      const action = await this.actionsModel.get({
        actionName: actionName,
      });
      if (!action) {
        throw new Error(`Could not find action: ${actionName}`);
      }
      const app = await this.apps.get({
        appKey: action.appKey!,
      });
      if (app.no_auth) {
        return this.actionsModel.execute({
          actionName: actionName,
          requestBody: {
            input: params,
            appName: action.appKey,
          },
        });
      }
      const connectedAccount = await this.getConnection({
        app: action.appKey,
        connectedAccountId,
      });

      if (!connectedAccount) {
        throw CEG.getCustomError(
          COMPOSIO_SDK_ERROR_CODES.SDK.NO_CONNECTED_ACCOUNT_FOUND,
          {
            message: `Could not find a connection with app='${action.appKey}' and entity='${this.id}'`,
            description: `Could not find a connection with app='${action.appKey}' and entity='${this.id}'`,
          }
        );
      }
      return this.actionsModel.execute({
        actionName: actionName,
        requestBody: {
          // @ts-ignore
          connectedAccountId: connectedAccount?.id as unknown as string,
          input: params,
          appName: action.appKey,
          text: text,
        },
      });
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async getConnection({ app, connectedAccountId }: ConnectionParams) {
    TELEMETRY_LOGGER.manualTelemetry(TELEMETRY_EVENTS.SDK_METHOD_INVOKED, {
      method: "getConnection",
      file: this.fileName,
      params: { app, connectedAccountId },
    });
    try {
      ZConnectionParams.parse({ app, connectedAccountId });
      if (connectedAccountId) {
        return await this.connectedAccounts.get({
          connectedAccountId,
        });
      }

      let latestAccount = null;
      let latestCreationDate: Date | null = null;
      const connectedAccounts = await this.connectedAccounts.list({
        user_uuid: this.id!,
      });

      if (!connectedAccounts.items || connectedAccounts.items.length === 0) {
        return null;
      }

      for (const account of connectedAccounts.items!) {
        if (account?.labels && account?.labels.includes(LABELS.PRIMARY)) {
          latestAccount = account;
          break;
        }
      }
      if (!latestAccount) {
        for (const connectedAccount of connectedAccounts.items!) {
          if (
            app?.toLocaleLowerCase() ===
            connectedAccount.appName.toLocaleLowerCase()
          ) {
            const creationDate = new Date(connectedAccount.createdAt!);
            if (
              (!latestAccount ||
                (latestCreationDate && creationDate > latestCreationDate)) &&
              connectedAccount.status === "ACTIVE"
            ) {
              latestCreationDate = creationDate;
              latestAccount = connectedAccount;
            }
          }
        }
      }
      if (!latestAccount) {
        return null;
      }

      return this.connectedAccounts.get({
        connectedAccountId: latestAccount.id!,
      });
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async setupTrigger({ app, triggerName, config }: TriggerSubscribeParam) {
    TELEMETRY_LOGGER.manualTelemetry(TELEMETRY_EVENTS.SDK_METHOD_INVOKED, {
      method: "setupTrigger",
      file: this.fileName,
      params: { app, triggerName, config },
    });
    try {
      ZTriggerSubscribeParam.parse({ app, triggerName, config });
      const connectedAccount = await this.getConnection({ app });
      if (!connectedAccount) {
        throw CEG.getCustomError(
          COMPOSIO_SDK_ERROR_CODES.SDK.NO_CONNECTED_ACCOUNT_FOUND,
          {
            description: `Could not find a connection with app='${app}' and entity='${this.id}'`,
          }
        );
      }
      const trigger = await this.triggerModel.setup({
        connectedAccountId: connectedAccount.id!,
        triggerName,
        config,
      });
      return trigger;
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  /* 
  deprecated
  */
  async disableTrigger(triggerId: string) {
    TELEMETRY_LOGGER.manualTelemetry(TELEMETRY_EVENTS.SDK_METHOD_INVOKED, {
      method: "disableTrigger",
      file: this.fileName,
      params: { triggerId },
    });
    try {
      await this.activeTriggers.disable({ triggerId: triggerId });
      return { status: "success" };
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async getConnections(): Promise<ConnectionItem[]> {
    /**
     * Get all connections for an entity.
     */
    TELEMETRY_LOGGER.manualTelemetry(TELEMETRY_EVENTS.SDK_METHOD_INVOKED, {
      method: "getConnections",
      file: this.fileName,
      params: {},
    });
    try {
      const connectedAccounts = await this.connectedAccounts.list({
        user_uuid: this.id,
      });
      return connectedAccounts.items!;
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async getActiveTriggers() {
    /**
     * Get all active triggers for an entity.
     */
    TELEMETRY_LOGGER.manualTelemetry(TELEMETRY_EVENTS.SDK_METHOD_INVOKED, {
      method: "getActiveTriggers",
      file: this.fileName,
      params: {},
    });
    try {
      const connectedAccounts = await this.getConnections();
      const activeTriggers = await this.activeTriggers.list({
        // @ts-ignore
        connectedAccountIds: connectedAccounts!
          .map((account) => account.id!)
          .join(","),
      });
      return activeTriggers;
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }

  async initiateConnection(
    data: InitiateConnectionParams
  ): Promise<ConnectionRequest> {
    TELEMETRY_LOGGER.manualTelemetry(TELEMETRY_EVENTS.SDK_METHOD_INVOKED, {
      method: "initiateConnection",
      file: this.fileName,
      params: { data },
    });
    try {
      const { appName, authMode, authConfig, integrationId, connectionData } =
        ZInitiateConnectionParams.parse(data);
      const { redirectUrl, labels } = data.config || {};

      if (!integrationId && !appName) {
        throw CEG.getCustomError(
          COMPOSIO_SDK_ERROR_CODES.COMMON.INVALID_PARAMS_PASSED,
          {
            message: "Please pass appName or integrationId",
            description:
              "We need atleast one of the params to initiate a connection",
          }
        );
      }

      /* Get the integration */
      const timestamp = new Date().toISOString().replace(/[-:.]/g, "");

      const isIntegrationIdPassed = !!integrationId;
      let integration = isIntegrationIdPassed
        ? await this.integrations.get({ integrationId: integrationId })
        : null;

      if (isIntegrationIdPassed && !integration) {
        throw CEG.getCustomError(
          COMPOSIO_SDK_ERROR_CODES.COMMON.INVALID_PARAMS_PASSED,
          {
            message: "Integration not found",
            description: "The integration with the given id does not exist",
          }
        );
      }

      /* If integration is not found, create a new integration */
      if (!isIntegrationIdPassed) {
        const app = await this.apps.get({ appKey: appName! });

        if (authMode) {
          integration = await this.integrations.create({
            appId: app.appId!,
            name: `integration_${timestamp}`,
            authScheme: authMode as z.infer<typeof ZAuthMode>,
            authConfig: authConfig,
            useComposioAuth: false,
          });
        } else {
          const isTestConnectorAvailable =
            app.testConnectors && app.testConnectors.length > 0;

          if (!isTestConnectorAvailable && app.no_auth === false) {
            logger.debug(
              "Auth schemes not provided, available auth schemes and authConfig"
            );
            // @ts-ignore
            for (const authScheme of app.auth_schemes) {
              logger.debug(
                "authScheme:",
                authScheme.name,
                "\n",
                "fields:",
                authScheme.fields
              );
            }

            throw new Error("Please pass authMode and authConfig.");
          }

          integration = await this.integrations.create({
            appId: app.appId!,
            name: `integration_${timestamp}`,
            useComposioAuth: true,
          });
        }
      }

      // Initiate the connection process
      return this.connectedAccounts.initiate({
        integrationId: integration!.id!,
        entityId: this.id,
        redirectUri: redirectUrl,
        //@ts-ignore
        data: connectionData,
        labels: labels,
      });
    } catch (error) {
      throw CEG.handleAllError(error);
    }
  }
}
