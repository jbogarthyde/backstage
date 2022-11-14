/*
 * Copyright 2022 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TokenManager } from '@backstage/backend-common';
import { PluginTaskScheduler, TaskRunner } from '@backstage/backend-tasks';
import { CatalogApi } from '@backstage/catalog-client';
import {
  Entity,
  LocationEntity,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import {
  BitbucketCloudIntegration,
  ScmIntegrations,
} from '@backstage/integration';
import {
  BitbucketCloudClient,
  Events,
  Models,
} from '@backstage/plugin-bitbucket-cloud-common';
import {
  DeferredEntity,
  EntityProvider,
  EntityProviderConnection,
  locationSpecToLocationEntity,
} from '@backstage/plugin-catalog-backend';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import { EventParams, EventSubscriber } from '@backstage/plugin-events-node';
import {
  BitbucketCloudEntityProviderConfig,
  readProviderConfigs,
} from './BitbucketCloudEntityProviderConfig';
import limiterFactory from 'p-limit';
import * as uuid from 'uuid';
import { Logger } from 'winston';

const DEFAULT_BRANCH = 'master';
const TOPIC_REPO_PUSH = 'bitbucketCloud/repo:push';

/** @public */
export const ANNOTATION_BITBUCKET_CLOUD_REPO_URL = 'bitbucket.org/repo-url';

interface IngestionTarget {
  fileUrl: string;
  repoUrl: string;
}

/**
 * Discovers catalog files located in [Bitbucket Cloud](https://bitbucket.org).
 * The provider will search your Bitbucket Cloud account and register catalog files matching the configured path
 * as Location entity and via following processing steps add all contained catalog entities.
 * This can be useful as an alternative to static locations or manually adding things to the catalog.
 *
 * @public
 */
export class BitbucketCloudEntityProvider
  implements EntityProvider, EventSubscriber
{
  private readonly client: BitbucketCloudClient;
  private readonly config: BitbucketCloudEntityProviderConfig;
  private readonly logger: Logger;
  private readonly scheduleFn: () => Promise<void>;
  private readonly catalogApi?: CatalogApi;
  private readonly tokenManager?: TokenManager;
  private connection?: EntityProviderConnection;

  private eventConfigErrorThrown = false;

  static fromConfig(
    config: Config,
    options: {
      catalogApi?: CatalogApi;
      logger: Logger;
      schedule?: TaskRunner;
      scheduler?: PluginTaskScheduler;
      tokenManager?: TokenManager;
    },
  ): BitbucketCloudEntityProvider[] {
    const integrations = ScmIntegrations.fromConfig(config);
    const integration = integrations.bitbucketCloud.byHost('bitbucket.org');
    if (!integration) {
      // this should never happen as we add a default integration,
      // but as a general safeguard, e.g. if this approach gets changed
      throw new Error('No integration for bitbucket.org available');
    }

    if (!options.schedule && !options.scheduler) {
      throw new Error('Either schedule or scheduler must be provided.');
    }

    return readProviderConfigs(config).map(providerConfig => {
      if (!options.schedule && !providerConfig.schedule) {
        throw new Error(
          `No schedule provided neither via code nor config for bitbucketCloud-provider:${providerConfig.id}.`,
        );
      }

      const taskRunner =
        options.schedule ??
        options.scheduler!.createScheduledTaskRunner(providerConfig.schedule!);

      return new BitbucketCloudEntityProvider(
        providerConfig,
        integration,
        options.logger,
        taskRunner,
        options.catalogApi,
        options.tokenManager,
      );
    });
  }

  private constructor(
    config: BitbucketCloudEntityProviderConfig,
    integration: BitbucketCloudIntegration,
    logger: Logger,
    taskRunner: TaskRunner,
    catalogApi?: CatalogApi,
    tokenManager?: TokenManager,
  ) {
    this.client = BitbucketCloudClient.fromConfig(integration.config);
    this.config = config;
    this.logger = logger.child({
      target: this.getProviderName(),
    });
    this.scheduleFn = this.createScheduleFn(taskRunner);
    this.catalogApi = catalogApi;
    this.tokenManager = tokenManager;
  }

  private createScheduleFn(schedule: TaskRunner): () => Promise<void> {
    return async () => {
      const taskId = this.getTaskId();
      return schedule.run({
        id: taskId,
        fn: async () => {
          const logger = this.logger.child({
            class: BitbucketCloudEntityProvider.prototype.constructor.name,
            taskId,
            taskInstanceId: uuid.v4(),
          });

          try {
            await this.refresh(logger);
          } catch (error) {
            logger.error(error);
          }
        },
      });
    };
  }

  /** {@inheritdoc @backstage/plugin-catalog-backend#EntityProvider.getProviderName} */
  getProviderName(): string {
    return `bitbucketCloud-provider:${this.config.id}`;
  }

  /** {@inheritdoc @backstage/plugin-catalog-backend#EntityProvider.getTaskId} */
  getTaskId(): string {
    return `${this.getProviderName()}:refresh`;
  }

  /** {@inheritdoc @backstage/plugin-catalog-backend#EntityProvider.connect} */
  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.scheduleFn();
  }

  async refresh(logger: Logger) {
    if (!this.connection) {
      throw new Error('Not initialized');
    }

    logger.info('Discovering catalog files in Bitbucket Cloud repositories');

    const targets = await this.findCatalogFiles();
    const entities = this.toDeferredEntities(targets);

    await this.connection.applyMutation({
      type: 'full',
      entities: entities,
    });

    logger.info(
      `Committed ${entities.length} Locations for catalog files in Bitbucket Cloud repositories`,
    );
  }

  /** {@inheritdoc @backstage/plugin-events-node#EventSubscriber.supportsEventTopics} */
  supportsEventTopics(): string[] {
    return [TOPIC_REPO_PUSH];
  }

  /** {@inheritdoc @backstage/plugin-events-node#EventSubscriber.onEvent} */
  async onEvent(params: EventParams): Promise<void> {
    if (params.topic !== TOPIC_REPO_PUSH) {
      return;
    }

    if (params.metadata?.['x-event-key'] === 'repo:push') {
      await this.onRepoPush(params.eventPayload as Events.RepoPushEvent);
    }
  }

  private canHandleEvents(): boolean {
    if (this.catalogApi && this.tokenManager) {
      return true;
    }

    // throw only once
    if (!this.eventConfigErrorThrown) {
      this.eventConfigErrorThrown = true;
      throw new Error(
        `${this.getProviderName()} not well configured to handle repo:push. Missing CatalogApi and/or TokenManager.`,
      );
    }

    return false;
  }

  async onRepoPush(event: Events.RepoPushEvent): Promise<void> {
    if (!this.canHandleEvents()) {
      return;
    }

    if (!this.connection) {
      throw new Error('Not initialized');
    }

    if (event.repository.workspace.slug !== this.config.workspace) {
      return;
    }

    if (!this.matchesFilters(event.repository)) {
      return;
    }

    const repoName = event.repository.slug;
    const repoUrl = event.repository.links!.html!.href!;
    this.logger.info(`handle repo:push event for ${repoUrl}`);

    // The commit information at the webhook only contains some high level metadata.
    // In order to understand whether relevant files have changed we would need to
    // look up all commits which would cost additional API calls.
    // The overall goal is to optimize the necessary amount of API calls.
    // Hence, we will just trigger a refresh for catalog file(s) within the repository
    // if we get notified about changes there.

    const targets = await this.findCatalogFiles(repoName);

    const { token } = await this.tokenManager!.getToken();
    const existing = await this.findExistingLocations(repoUrl, token);

    const added: DeferredEntity[] = this.toDeferredEntities(
      targets.filter(
        // All Locations are managed by this provider and only have `target`, never `targets`.
        // All URLs (fileUrl, target) are created using `BitbucketCloudEntityProvider.toUrl`.
        // Hence, we can keep the comparison simple and don't need to handle different
        // casing  or encoding, etc.
        target => !existing.find(item => item.spec.target === target.fileUrl),
      ),
    );

    const limiter = limiterFactory(10);

    const stillExisting: Entity[] = [];
    const removed: DeferredEntity[] = [];
    existing.forEach(item => {
      if (targets.find(value => value.fileUrl === item.spec.target)) {
        stillExisting.push(item);
      } else {
        removed.push({
          locationKey: this.getProviderName(),
          entity: item,
        });
      }
    });

    const promises: Promise<void>[] = stillExisting.map(entity =>
      limiter(async () =>
        this.catalogApi!.refreshEntity(stringifyEntityRef(entity), { token }),
      ),
    );

    if (added.length > 0 || removed.length > 0) {
      const connection = this.connection;
      promises.push(
        limiter(async () =>
          connection.applyMutation({
            type: 'delta',
            added: added,
            removed: removed,
          }),
        ),
      );
    }

    await Promise.all(promises);
  }

  private async findExistingLocations(
    repoUrl: string,
    token: string,
  ): Promise<LocationEntity[]> {
    const filter: Record<string, string> = {};
    filter.kind = 'Location';
    filter[`metadata.annotations.${ANNOTATION_BITBUCKET_CLOUD_REPO_URL}`] =
      repoUrl;

    return this.catalogApi!.getEntities({ filter }, { token }).then(
      result => result.items,
    ) as Promise<LocationEntity[]>;
  }

  private async findCatalogFiles(
    repoName?: string,
  ): Promise<IngestionTarget[]> {
    const workspace = this.config.workspace;
    const catalogPath = this.config.catalogPath;

    const catalogFilename = catalogPath.substring(
      catalogPath.lastIndexOf('/') + 1,
    );

    // load all fields relevant for creating refs later, but not more
    const fields = [
      // exclude code/content match details
      '-values.content_matches',
      // include/add relevant repository details
      '+values.file.commit.repository.mainbranch.name',
      '+values.file.commit.repository.project.key',
      '+values.file.commit.repository.slug',
      // remove irrelevant links
      '-values.*.links',
      '-values.*.*.links',
      '-values.*.*.*.links',
      // ...except the one we need
      '+values.file.commit.repository.links.html.href',
    ].join(',');
    const optRepoFilter = repoName ? ` repo:${repoName}` : '';
    const query = `"${catalogFilename}" path:${catalogPath}${optRepoFilter}`;
    const searchResults = this.client
      .searchCode(workspace, query, { fields })
      .iterateResults();

    const result: IngestionTarget[] = [];

    for await (const searchResult of searchResults) {
      // not a file match, but a code match
      if (searchResult.path_matches!.length === 0) {
        continue;
      }

      const repository = searchResult.file!.commit!.repository!;
      if (this.matchesFilters(repository)) {
        result.push({
          fileUrl: BitbucketCloudEntityProvider.toUrl(
            repository,
            searchResult.file!.path!,
          ),
          repoUrl: repository.links!.html!.href!,
        });
      }
    }

    return result;
  }

  private matchesFilters(repository: Models.Repository): boolean {
    const filters = this.config.filters;
    return (
      !filters ||
      ((!filters.projectKey ||
        filters.projectKey.test(repository.project!.key!)) &&
        (!filters.repoSlug || filters.repoSlug.test(repository.slug!)))
    );
  }

  private toDeferredEntities(targets: IngestionTarget[]): DeferredEntity[] {
    return targets
      .map(target => {
        const location = BitbucketCloudEntityProvider.toLocationSpec(
          target.fileUrl,
        );
        const entity = locationSpecToLocationEntity({ location });
        entity.metadata.annotations = {
          ...entity.metadata.annotations,
          [ANNOTATION_BITBUCKET_CLOUD_REPO_URL]: target.repoUrl,
        };
        return entity;
      })
      .map(entity => {
        return {
          locationKey: this.getProviderName(),
          entity: entity,
        };
      });
  }

  private static toUrl(
    repository: Models.Repository,
    filePath: string,
  ): string {
    const repoUrl = repository.links!.html!.href!;
    const branch = repository.mainbranch?.name ?? DEFAULT_BRANCH;

    return `${repoUrl}/src/${branch}/${filePath}`;
  }

  private static toLocationSpec(target: string): LocationSpec {
    return {
      type: 'url',
      target: target,
      presence: 'required',
    };
  }
}
