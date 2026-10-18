<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('templates.title') }}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input
          v-model="searchText"
          class="form-input"
          style="width:200px"
          :placeholder="t('common.search')"
        />
        <template v-if="selectedIds.length">
          <button class="btn btn-secondary" @click="shareSelected">
            <i :class="sharedMulti ? 'fa-solid fa-check' : 'fa-solid fa-share-nodes'"></i>
            {{ t('templates.shareSelectedBtn').replace('{n}', String(selectedIds.length)) }}
          </button>
          <button class="btn btn-secondary" :disabled="isMutingBot" @click="bulkMuteBotForever"><i class="fa-solid fa-bell-slash"></i> {{ t('templates.bulkMuteBotForever') }}</button>
          <button class="btn btn-secondary" @click="bulkEnableTpls"><i class="fa-solid fa-circle-check"></i> {{ t('templates.bulkEnable').replace('{n}', String(selectedIds.length)) }}</button>
          <button class="btn btn-secondary" @click="confirmBulkDisableTpls = true"><i class="fa-solid fa-ban"></i> {{ t('templates.bulkDisable').replace('{n}', String(selectedIds.length)) }}</button>
          <button class="btn btn-danger" @click="confirmBulkDeleteTpls = true"><i class="fa-solid fa-trash"></i> {{ t('templates.bulkDelete').replace('{n}', String(selectedIds.length)) }}</button>
        </template>
        <button v-if="templates.length" class="btn btn-secondary" @click="toggleAll">
          {{ allSelected ? t('common.deselectAll') : t('common.selectAll') }}
        </button>
        <button class="btn btn-secondary" @click="openImport"><i class="fa-solid fa-file-import"></i> {{ t('templates.importBtn') }}</button>
        <button class="btn btn-primary" @click="openAdd"><i class="fa-solid fa-plus"></i> {{ t('templates.addBtn') }}</button>
      </div>
    </div>

    <div v-if="importNotice" class="success-msg" style="margin-bottom:12px">
      {{ importNotice }}
      <button class="btn btn-ghost btn-sm btn-icon" style="margin-left:8px" @click="importNotice = ''">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>

    <div class="card">
      <PaginationBar
        :page="page"
        :page-size="pageSize"
        :total="total"
        @update:page="onPageChange"
        @update:page-size="onPageSizeChange"
      />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="th-sort" :class="sortKey === 'name' ? 'sort-active' : ''" @click="setSort('name')">{{ t('common.name') }} <span class="sort-icon">{{ sortIcon('name') }}</span></th>
              <th class="th-sort" :class="sortKey === 'type' ? 'sort-active' : ''" @click="setSort('type')">{{ t('templates.colType') }} <span class="sort-icon">{{ sortIcon('type') }}</span></th>
              <th class="th-sort" :class="sortKey === 'enabled' ? 'sort-active' : ''" @click="setSort('enabled')">{{ t('templates.colEnabled') }} <span class="sort-icon">{{ sortIcon('enabled') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'botUrl' ? 'sort-active' : ''" @click="setSort('botUrl')">{{ t('templates.colBotUrl') }} <span class="sort-icon">{{ sortIcon('botUrl') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'linkedJobs' ? 'sort-active' : ''" @click="setSort('linkedJobs')">{{ t('templates.colLinkedJobs') }} <span class="sort-icon">{{ sortIcon('linkedJobs') }}</span></th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!templates.length">
              <td colspan="6" class="empty">{{ t('templates.noTemplates') }}</td>
            </tr>
            <tr
              v-for="(tpl, idx) in templates"
              :key="tpl.id"
              style="cursor:pointer"
              :class="selectedIds.includes(tpl.id) ? 'row-selected' : ''"
              @click="toggleSelect(tpl.id, idx, $event)"
            >
              <td>{{ tpl.name }}</td>
              <td><span :class="jobTypeBadge(tpl.jobType)">{{ t(`logs.jobType.${tpl.jobType}`) }}</span></td>
              <td>
                <span
                  :class="tpl.enabled ? 'badge badge-green' : 'badge badge-grey'"
                  style="cursor:pointer;user-select:none"
                  @click.stop="toggleTemplateEnabled(tpl)"
                >
                  {{ tpl.enabled ? t('common.yes') : t('common.no') }}
                </span>
              </td>
              <td class="col-hide-mobile">{{ tpl.jobType === 'embywatch' ? tpl.botUsername : '@' + tpl.botUsername }}</td>
              <td class="col-hide-mobile">{{ tpl.linkedJobCount ?? 0 }}</td>
              <td @click.stop>
                <div class="actions hide-mobile">
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.createJobsBtn')"
                    @click="openCreateJobs(tpl)"
                  ><i class="fa-solid fa-list-check"></i></button>
                  <button
                    v-if="(tpl.linkedJobCount ?? 0) > 0"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.enableLinkedJobs')"
                    @click="setLinkedJobsEnabled(tpl, true)"
                  ><i class="fa-solid fa-circle-check"></i></button>
                  <button
                    v-if="(tpl.linkedJobCount ?? 0) > 0"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.disableLinkedJobs')"
                    @click="setLinkedJobsEnabled(tpl, false)"
                  ><i class="fa-solid fa-circle-xmark"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="copiedTplId === tpl.id ? t('templates.shareCopied') : t('templates.shareBtn')" @click="shareTemplate(tpl)">
                    <i :class="copiedTplId === tpl.id ? 'fa-solid fa-check' : 'fa-solid fa-share-nodes'"></i>
                  </button>
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.duplicateBtn')"
                    :disabled="duplicatingId !== null"
                    @click="duplicateTemplate(tpl)"
                  ><i class="fa-solid fa-clone"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.edit')" @click="openEdit(tpl)"><i class="fa-solid fa-pen"></i></button>
                  <button class="btn btn-sm btn-danger btn-icon" :title="t('common.delete')" @click="openDeleteTpl(tpl.id)"><i class="fa-solid fa-trash"></i></button>
                </div>
                <button class="btn btn-sm btn-ghost btn-icon show-mobile" @click="actionMenuTpl = tpl">
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add / Edit modal -->
    <div v-if="showForm" class="modal-backdrop">
      <div class="modal" style="width:560px">
        <h3 class="modal-title">{{ t(editTarget ? 'templates.editTitle' : 'templates.addTitle') }}</h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>

          <!-- Template Name + Job Type -->
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('templates.labelName') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="form.name" class="form-input" placeholder="My Template" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelType') }}</label>
              <select v-model="form.jobType" class="form-select" @change="onJobTypeChange">
                <option value="checkin">Check-in (签到)</option>
                <option value="embywatch">Emby Watch (观看)</option>
                <option value="custom">Custom (自定义)</option>
                <option value="autoreg">Auto Registration (抢注)</option>
              </select>
            </div>
          </div>

          <!-- Check-in: Bot Username -->
          <div v-if="form.jobType === 'checkin'" class="form-group">
            <label class="form-label">{{ t('jobs.labelBot') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
          </div>

          <!-- Emby Watch: Server URL -->
          <div v-if="form.jobType === 'embywatch'" class="form-group">
            <label class="form-label">{{ t('jobs.labelServerUrl') }} <span style="color:#e63946">*</span></label>
            <div style="display:flex;align-items:center;gap:6px">
              <select v-model="embyServer.protocol" class="form-select" style="width:88px;flex-shrink:0">
                <option value="https">https</option>
                <option value="http">http</option>
              </select>
              <span style="color:#aaa;font-size:13px;flex-shrink:0">://</span>
              <input v-model.trim="embyServer.host" class="form-input" placeholder="emby.xxxx.com" @paste="handleEmbyHostPaste" />
              <span style="color:#aaa;font-size:13px;flex-shrink:0">:</span>
              <input v-model.number="embyServer.port" class="form-input" type="number" min="1" max="65535" style="width:72px;flex-shrink:0" placeholder="443" />
            </div>
          </div>

          <!-- embywatch-specific fields (credentials are set per-job, not in template) -->
          <template v-if="form.jobType === 'embywatch'">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">
                  {{ t('jobs.labelPlayDuration') }}
                  <span style="color:#aaa;font-weight:400"> — {{ t('common.blankForDefault') }}</span>
                </label>
                <input v-model.number="embyCfg.playDuration" class="form-input" type="number" min="30" placeholder="300" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelUserAgent') }}</label>
              <select v-model="embyUaDropdown" class="form-select" @change="onUaDropdownChange">
                <option value="">{{ t('jobs.uaDefault') }}</option>
                <option v-for="p in uaPresets" :key="p.name" :value="p.name">{{ p.name }}</option>
                <option value="__custom__">{{ t('jobs.uaCustom') }}</option>
              </select>
              <textarea
                v-if="embyUaDropdown === '__custom__'"
                v-model.trim="embyCfg.userAgent"
                class="form-input"
                rows="2"
                style="margin-top:6px;resize:vertical"
                placeholder="Mozilla/5.0 ..."
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelLibrary') }}</label>
              <input v-model.trim="embyCfg.library" class="form-input" type="text" :placeholder="t('jobs.libraryPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.libraryHint') }}</div>
            </div>
            <div class="emby-rules-hint">{{ t('jobs.playbackRulesHint') }}</div>
            <div class="form-group" style="margin-top:4px">
              <label class="form-check">
                <input v-model="embyCfg.markWatched" type="checkbox" />
                <span>{{ t('jobs.labelMarkWatched') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.markWatchedHint') }}</div>
            </div>
            <div class="form-group" style="margin-top:4px">
              <label class="form-check">
                <input v-model="embyCfg.verifyPlayable" type="checkbox" />
                <span>{{ t('jobs.labelVerifyPlayable') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.verifyPlayableHint') }}</div>
            </div>
            <div class="form-group" style="margin-top:4px">
              <label class="form-check">
                <input v-model="embyCfg.realWatch" type="checkbox" />
                <span>{{ t('jobs.labelRealWatch') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.realWatchHint') }}</div>
            </div>
            <div class="form-group" style="margin-top:4px">
              <label class="form-check">
                <input v-model="embyCfg.sequencePlay" type="checkbox" />
                <span>{{ t('jobs.labelSequencePlay') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.sequencePlayHint') }}</div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelRunEveryDays') }}</label>
                <input v-model.trim="runEveryDaysText" class="form-input" type="text" :placeholder="t('jobs.runEveryDaysPlaceholder')" style="max-width:120px" />
                <div style="font-size:11px;margin-top:4px" :style="runEveryDaysValid ? 'color:#aaa' : 'color:#991b1b'">{{ t('jobs.runEveryDaysHint') }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
                <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
              </div>
            </div>
          </template>

          <!-- Custom: target bot + action chain -->
          <template v-if="form.jobType === 'custom'">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.custom.labelTarget') }}</label>
              <input v-model.trim="form.botUsername" class="form-input" placeholder="BotUsername" />
            </div>

            <div class="form-group">
              <label class="form-label">{{ t('jobs.custom.labelJobMaxRetries') }}</label>
              <input v-model.number="customJobMaxRetries" class="form-input" type="number" min="1" max="20" style="max-width:120px" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.jobMaxRetriesHint') }}</div>
            </div>

            <div class="form-group">
              <label class="form-label">{{ t('jobs.custom.actions') }}</label>
              <div v-if="customActions.length === 0" style="font-size:13px;color:#aaa;padding:10px 0">{{ t('jobs.custom.noActions') }}</div>
              <div v-for="(action, i) in customActions" :key="i" class="custom-action-card">
                <div class="custom-action-header">
                  <span class="custom-action-num">{{ i + 1 }}</span>
                  <select v-model="action.type" class="form-select custom-action-type-select">
                    <option value="send_command">{{ t('jobs.custom.actionSendCommand') }}</option>
                    <option value="send_contact_message">{{ t('jobs.custom.actionSendContactMessage') }}</option>
                    <option value="wait_reply">{{ t('jobs.custom.actionWaitReply') }}</option>
                    <option value="delay">{{ t('jobs.custom.actionDelay') }}</option>
                    <option value="click_button">{{ t('jobs.custom.actionClickButton') }}</option>
                    <option value="click_message_button">{{ t('jobs.custom.actionClickMessageButton') }}</option>
                    <option value="ai_multiple_btn" :disabled="aiKeyMissing">{{ t('jobs.custom.actionAiMultipleBtn') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                    <option value="enter_captcha" :disabled="aiKeyMissing">{{ t('jobs.custom.actionEnterCaptcha') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                    <option value="join_group">{{ t('jobs.custom.actionJoinGroup') }}</option>
                    <option value="subscribe_channel">{{ t('jobs.custom.actionSubscribeChannel') }}</option>
                    <option value="open_mini_app" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenMiniApp') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                    <option value="open_mini_app_url" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenMiniAppUrl') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                    <option value="open_bot_menu_app" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenBotMenuApp') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                    <option value="open_url" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenUrl') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                  </select>
                  <button type="button" class="btn btn-ghost btn-sm btn-icon" :disabled="i === 0" @click="moveUp(i)"><i class="fa-solid fa-arrow-up"></i></button>
                  <button type="button" class="btn btn-ghost btn-sm btn-icon" :disabled="i === customActions.length - 1" @click="moveDown(i)"><i class="fa-solid fa-arrow-down"></i></button>
                  <button type="button" class="btn btn-danger btn-sm btn-icon" @click="removeAction(i)"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <!-- send_command -->
                <div v-if="action.type === 'send_command'" class="custom-action-params">
                  <div class="form-row" style="margin-bottom:0">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
                      <select v-model="action.contentDropdown" class="form-select">
                        <option value="/start">/start</option>
                        <option value="/checkin">/checkin</option>
                        <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                        <option value="custom">{{ t('common.custom') }}...</option>
                      </select>
                      <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                      <template v-if="action.contentDropdown === '{aiInput}'">
                        <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                        <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                        <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                      </template>
                      <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                  </div>
                </div>

                <!-- send_contact_message -->
                <div v-if="action.type === 'send_contact_message'" class="custom-action-params">
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
                    <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
                  </div>
                  <div class="form-row" style="margin-bottom:0;margin-top:8px">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
                      <select v-model="action.contentDropdown" class="form-select">
                        <option value="/start">/start</option>
                        <option value="/checkin">/checkin</option>
                        <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                        <option value="custom">{{ t('common.custom') }}...</option>
                      </select>
                      <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                      <template v-if="action.contentDropdown === '{aiInput}'">
                        <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                        <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                        <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                      </template>
                      <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                  </div>
                </div>

                <!-- wait_reply -->
                <div v-if="action.type === 'wait_reply'" class="custom-action-params">
                  <div class="form-row" style="margin-bottom:0">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                      <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                    <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                    <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                    <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                  </div>
                </div>

                <!-- delay -->
                <div v-if="action.type === 'delay'" class="custom-action-params">
                  <label class="form-label">{{ t('jobs.custom.labelWaitMs') }}</label>
                  <input v-model.number="action.waitMs" class="form-input" type="number" min="100" step="500" />
                </div>

                <!-- click_button -->
                <div v-if="action.type === 'click_button'" class="custom-action-params">
                  <div class="form-row" style="margin-bottom:0">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelButton') }}</label>
                      <select v-model="action.buttonDropdown" class="form-select">
                        <option value="签到">签到</option>
                        <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                        <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                        <option value="custom">{{ t('common.custom') }}...</option>
                      </select>
                      <input v-if="action.buttonDropdown === 'custom'" v-model="action.buttonCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
                      <template v-if="action.buttonDropdown === '{aiBtn}'">
                        <input v-model.trim="action.buttonAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                        <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                        <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                      </template>
                      <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                    <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                    <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                    <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-checkbox-label">
                      <input type="checkbox" v-model="action.cfChallenge" :disabled="cfBrowserMissing" />
                      {{ t('jobs.custom.labelCfChallenge') }}
                    </label>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.cfChallengeHint') }}</div>
                    <div v-if="cfBrowserMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.cfBrowserWarning') }}</div>
                  </div>
                </div>

                <!-- click_message_button -->
                <div v-if="action.type === 'click_message_button'" class="custom-action-params">
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
                    <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
                  </div>
                  <div class="form-row" style="margin-bottom:0;margin-top:8px">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelButton') }}</label>
                      <select v-model="action.buttonDropdown" class="form-select">
                        <option value="签到">签到</option>
                        <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                        <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                        <option value="custom">{{ t('common.custom') }}...</option>
                      </select>
                      <input v-if="action.buttonDropdown === 'custom'" v-model="action.buttonCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
                      <template v-if="action.buttonDropdown === '{aiBtn}'">
                        <input v-model.trim="action.buttonAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                        <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                        <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                      </template>
                      <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                    <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                    <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                    <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                  </div>
                </div>

                <!-- ai_multiple_btn -->
                <div v-if="action.type === 'ai_multiple_btn'" class="custom-action-params">
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelContactOptional') }}</label>
                    <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactOptionalHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.aiHintLabel') }}</label>
                    <input v-model.trim="action.buttonAiHint" class="form-input" :placeholder="t('jobs.aiHintPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.aiMultipleBtnHint') }}</div>
                    <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                  </div>
                  <div class="form-row" style="margin-bottom:0;margin-top:8px">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelGapMs') }}</label>
                      <input v-model.number="action.gapMs" class="form-input" type="number" min="0" step="500" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.gapMsHint') }}</div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                    <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                    <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                    <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-checkbox-label">
                      <input type="checkbox" v-model="action.cfChallenge" :disabled="cfBrowserMissing" />
                      {{ t('jobs.custom.labelCfChallenge') }}
                    </label>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.cfChallengeHint') }}</div>
                    <div v-if="cfBrowserMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.cfBrowserWarning') }}</div>
                  </div>
                </div>

                <!-- enter_captcha -->
                <div v-if="action.type === 'enter_captcha'" class="custom-action-params">
                  <div class="form-row" style="margin-bottom:0">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                      <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelCaptchaLength') }}</label>
                      <input v-model.trim="action.captchaLength" class="form-input" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                  </div>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                  <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                </div>

                <!-- join_group -->
                <div v-if="action.type === 'join_group'" class="custom-action-params">
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelGroupId') }}</label>
                    <input v-model.trim="action.groupId" class="form-input" :placeholder="t('jobs.custom.groupIdPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.groupIdHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-checkbox-label">
                      <input type="checkbox" v-model="action.checkMembership" />
                      {{ t('jobs.custom.labelCheckMembership') }}
                    </label>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.checkMembershipHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelVerifyButton') }}</label>
                    <input v-model.trim="action.verifyButton" class="form-input" :placeholder="t('jobs.custom.verifyButtonPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.verifyButtonHint') }}</div>
                  </div>
                  <div v-if="action.verifyButton" class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelVerifyWaitMs') }}</label>
                    <input v-model.number="action.verifyWaitMs" type="number" min="1000" step="1000" class="form-input" />
                  </div>
                </div>

                <!-- subscribe_channel -->
                <div v-if="action.type === 'subscribe_channel'" class="custom-action-params">
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.custom.labelChannelId') }}</label>
                    <input v-model.trim="action.channelId" class="form-input" :placeholder="t('jobs.custom.channelIdPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.channelIdHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-checkbox-label">
                      <input type="checkbox" v-model="action.checkMembership" />
                      {{ t('jobs.custom.labelCheckSubscription') }}
                    </label>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.checkSubscriptionHint') }}</div>
                  </div>
                </div>

                <!-- open_mini_app / open_mini_app_url / open_bot_menu_app -->
                <div v-if="action.type === 'open_mini_app' || action.type === 'open_mini_app_url' || action.type === 'open_bot_menu_app'" class="custom-action-params">
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ action.type === 'open_mini_app' ? t('jobs.custom.labelContactOptional') : action.type === 'open_mini_app_url' ? t('jobs.custom.labelMiniAppOwner') : t('jobs.custom.labelMenuAppOwner') }}</label>
                    <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ action.type === 'open_mini_app' ? t('jobs.custom.contactOptionalHint') : action.type === 'open_mini_app_url' ? t('jobs.custom.miniAppOwnerHint') : t('jobs.custom.menuAppOwnerHint') }}</div>
                  </div>
                  <div v-if="action.type === 'open_mini_app_url'" class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppUrl') }}</label>
                    <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.custom.miniAppUrlPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppUrlHint') }}</div>
                  </div>
                  <div v-if="action.type === 'open_mini_app'" class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppButton') }}</label>
                    <input v-model.trim="action.button" class="form-input" :placeholder="t('jobs.custom.miniAppButtonPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppButtonHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelInAppButton') }}</label>
                    <input v-model.trim="action.appButton" class="form-input" :placeholder="t('jobs.custom.inAppButtonPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.inAppButtonHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                    <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                    <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                  </div>
                  <div class="form-row" style="margin-bottom:0;margin-top:8px">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
                      <input v-model.number="action.miniAppMaxWaitMs" class="form-input" type="number" min="0" step="10000" placeholder="300000" />
                    </div>
                  </div>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppProxy') }}</label>
                    <select v-model="action.miniAppProxyId" class="form-select">
                      <option value="">{{ t('jobs.custom.miniAppProxyJob') }}</option>
                      <option value="direct">{{ t('jobs.custom.miniAppProxyDirect') }}</option>
                      <option v-for="p in proxiesList" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </select>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppProxyHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-checkbox-label">
                      <input type="checkbox" v-model="action.miniAppTryAllProxies" />
                      {{ t('jobs.custom.labelMiniAppTryAll') }}
                    </label>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
                  </div>
                </div>

                <!-- open_url -->
                <div v-if="action.type === 'open_url'" class="custom-action-params">
                  <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">{{ t('jobs.web.labelUrl') }}</label>
                    <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.web.urlPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.web.urlHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:10px">
                    <WebStepsEditor :steps="action.webSteps" :ai-key-missing="aiKeyMissing" />
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                    <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                    <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                  </div>
                  <div class="form-row" style="margin-bottom:0;margin-top:8px">
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                      <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                    </div>
                    <div class="form-group">
                      <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
                      <input v-model.number="action.miniAppMaxWaitMs" class="form-input" type="number" min="0" step="10000" placeholder="300000" />
                    </div>
                  </div>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppProxy') }}</label>
                    <select v-model="action.miniAppProxyId" class="form-select">
                      <option value="">{{ t('jobs.custom.miniAppProxyJob') }}</option>
                      <option value="direct">{{ t('jobs.custom.miniAppProxyDirect') }}</option>
                      <option v-for="p in proxiesList" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </select>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppProxyHint') }}</div>
                  </div>
                  <div class="form-group" style="margin-bottom:0;margin-top:8px">
                    <label class="form-checkbox-label">
                      <input type="checkbox" v-model="action.miniAppTryAllProxies" />
                      {{ t('jobs.custom.labelMiniAppTryAll') }}
                    </label>
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
                  </div>
                </div>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" @click="addAction">
                <i class="fa-solid fa-plus"></i> {{ t('jobs.custom.addAction') }}
              </button>
            </div>
          </template>

          <!-- Auto registration -->
          <template v-if="form.jobType === 'autoreg'">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelBot') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelGroup') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="autoregCfg.groupId" class="form-input" placeholder="@groupname" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.groupHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelCodePrefix') }} <span v-if="!autoregCfg.codeRegex" style="color:#e63946">*</span></label>
              <input v-model.trim="autoregCfg.codePrefix" class="form-input" placeholder="ABC-*-XYZ_" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codePrefixHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelCodeRegex') }} <span v-if="!autoregCfg.codePrefix" style="color:#e63946">*</span></label>
              <input v-model.trim="autoregCfg.codeRegex" class="form-input" :placeholder="t('jobs.autoreg.codeRegexPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codeRegexHint') }}</div>
              <div style="font-size:11px;color:#777;margin-top:3px">{{ t('jobs.autoreg.eitherPrefixOrRegex') }}</div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-check">
                  <input v-model="autoregCfg.stripChinese" type="checkbox" />
                  <span>{{ t('jobs.autoreg.labelStripChinese') }}</span>
                </label>
                <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.stripChineseHint') }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('jobs.autoreg.labelStripChars') }}</label>
                <input v-model.trim="autoregCfg.stripChars" class="form-input" :placeholder="t('jobs.autoreg.stripCharsPlaceholder')" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.stripCharsHint') }}</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.aiModifyCode" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelAiModifyCode') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.aiModifyCodeHint') }}</div>
            </div>
            <div v-if="autoregCfg.aiModifyCode" class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.autoreg.labelAiModifyCodeHint') }}</label>
                <input v-model.trim="autoregCfg.aiModifyCodeHint" class="form-input" :placeholder="t('jobs.autoreg.aiModifyCodeHintPlaceholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('jobs.autoreg.labelAiContextCount') }}</label>
                <input v-model.number="autoregCfg.aiContextCount" class="form-input" type="number" min="0" max="50" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.aiContextCountHint') }}</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelEntryMode') }}</label>
              <select v-model="autoregCfg.entryMode" class="form-select">
                <option value="button">{{ t('jobs.autoreg.entryModeButton') }}</option>
                <option value="command">{{ t('jobs.autoreg.entryModeCommand') }}</option>
              </select>
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.entryModeHint') }}</div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelStartCommand') }}</label>
                <select v-model="cmdDropdown" class="form-select">
                  <option value="">({{ t('common.default') }}: /start)</option>
                  <option value="/start">/start</option>
                  <option value="custom">{{ t('common.custom') }}...</option>
                </select>
                <input v-if="cmdDropdown === 'custom'" v-model.trim="cmdCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
              </div>
              <div v-if="autoregCfg.entryMode === 'button'" class="form-group">
                <label class="form-label">{{ t('jobs.autoreg.labelRegisterButton') }}</label>
                <input v-model.trim="autoregCfg.registerButton" class="form-input" :placeholder="t('jobs.autoreg.registerButtonPlaceholder')" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.registerButtonHint') }}</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelCodeReady') }}</label>
              <input v-model.trim="autoregCfg.codeReadyContains" class="form-input" :placeholder="t('jobs.autoreg.codeReadyPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codeReadyHint') }}</div>
            </div>
            <!-- Some bots vet the code first, then offer a button/link that opens registration -->
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.clickAfterCode" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelClickAfterCode') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.clickAfterCodeHint') }}</div>
            </div>
            <div v-if="autoregCfg.clickAfterCode" class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.autoreg.labelAfterCodeButton') }}</label>
                <input v-model.trim="autoregCfg.afterCodeButton" class="form-input" :placeholder="t('jobs.autoreg.afterCodeButtonPlaceholder')" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.afterCodeButtonHint') }}</div>
              </div>
              <div class="form-group">
                <label class="form-check">
                  <input v-model="autoregCfg.afterCodeRequired" type="checkbox" />
                  <span>{{ t('jobs.autoreg.labelAfterCodeRequired') }}</span>
                </label>
                <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.afterCodeRequiredHint') }}</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelSignupUsername') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="autoregCfg.signupUsername" class="form-input" placeholder="myname{num:3}" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.signupUsernameHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelUsernameReady') }}</label>
              <input v-model.trim="autoregCfg.usernameReadyContains" class="form-input" :placeholder="t('jobs.autoreg.usernameReadyPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.usernameReadyHint') }}</div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.autoreg.labelListenMinutes') }}</label>
                <input v-model.number="autoregCfg.listenMinutes" class="form-input" type="number" min="1" max="1440" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.listenMinutesHint') }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('jobs.autoreg.labelScanHistory') }}</label>
                <input v-model.number="autoregCfg.scanHistoryCount" class="form-input" type="number" min="0" max="100" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.scanHistoryHint') }}</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
              <input v-model.trim="autoregCfg.successContains" class="form-input" :placeholder="t('jobs.autoreg.successContainsPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.successContainsHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
              <input v-model.trim="autoregCfg.failContains" class="form-input" :placeholder="t('jobs.autoreg.failContainsPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.failContainsHint') }}</div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelReplyTimeout') }}</label>
                <input v-model.number="form.replyTimeoutMs" class="form-input" type="number" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
                <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
              </div>
            </div>
          </template>

          <!-- checkin-specific fields -->
          <template v-if="form.jobType === 'checkin'">
            <div class="form-row" style="align-items:start">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelStartCommand') }}</label>
                <select v-model="cmdDropdown" class="form-select">
                  <option value="">({{ t('common.default') }}: /start)</option>
                  <option value="/start">/start</option>
                  <option value="/checkin">/checkin</option>
                  <option value="custom">{{ t('common.custom') }}...</option>
                </select>
                <input v-if="cmdDropdown === 'custom'" v-model.trim="cmdCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.startCommandHint') }}</div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelCheckinButton') }}</label>
                <select v-model="btnDropdown" class="form-select">
                  <option value="">({{ t('common.default') }}: 签到)</option>
                  <option value="签到">签到</option>
                  <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                  <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                  <option value="custom">{{ t('common.custom') }}...</option>
                </select>
                <input v-if="btnDropdown === 'custom'" v-model.trim="btnCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
                <template v-if="btnDropdown === '{aiBtn}'">
                  <input v-model.trim="btnAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                  <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                </template>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelReplyTimeout') }}</label>
                <input v-model.number="form.replyTimeoutMs" class="form-input" type="number" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
                <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
              <input v-model.trim="tplCheckinSuccessContains" class="form-input" :placeholder="t('jobs.successContainsPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.successContainsHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
              <input v-model.trim="tplCheckinFailContains" class="form-input" :placeholder="t('jobs.failContainsPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.failContainsHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-checkbox-label">
                <input type="checkbox" v-model="tplCheckinCfChallenge" :disabled="cfBrowserMissing" />
                {{ t('jobs.custom.labelCfChallenge') }}
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.cfChallengeHint') }}</div>
              <div v-if="cfBrowserMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.cfBrowserWarning') }}</div>
            </div>
          </template>

          <div v-if="proxiesList.length" class="form-group">
            <label class="form-label">{{ t('jobs.labelProxy') }}</label>
            <select v-model="tplProxyId" class="form-select">
              <option value="">{{ t('jobs.proxyNone') }}</option>
              <option v-for="p in proxiesList" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.proxyBrowserOnlyHint') }}</div>
          </div>

        </div><!-- end modal-body -->
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showForm = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveTemplate">
            <i class="fa-solid fa-floppy-disk"></i> {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Create jobs from template modal -->
    <div v-if="showCreateJobs" class="modal-backdrop">
      <div class="modal" style="width:600px;max-height:90vh;overflow-y:auto">
        <h3 class="modal-title">{{ t('templates.createJobsTitle') }} — {{ createJobsTpl?.name }}</h3>
        <div class="modal-body">
          <div v-if="createJobsError" class="error-msg">{{ createJobsError }}</div>

          <!-- Schedule window -->
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('templates.createJobsWindowStart') }}</label>
              <input v-model.number="createJobsWindowStart" class="form-input" type="number" min="0" max="2359" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('templates.createJobsWindowEnd') }}</label>
              <input v-model.number="createJobsWindowEnd" class="form-input" type="number" min="0" max="2359" />
            </div>
          </div>

          <!-- Account list -->
          <div class="form-group">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <label class="form-label" style="margin-bottom:0">{{ t('templates.createJobsAvailableAccounts') }}</label>
              <div style="display:flex;gap:6px">
                <button type="button" class="btn btn-ghost btn-sm" @click="createJobsSelectAll">{{ t('templates.createJobsSelectAll') }}</button>
                <button type="button" class="btn btn-ghost btn-sm" @click="createJobsDeselectAll">{{ t('templates.createJobsDeselectAll') }}</button>
              </div>
            </div>
            <div v-if="createJobsLoading" style="text-align:center;padding:16px;color:#888">
              <i class="fa-solid fa-spinner fa-spin"></i>
            </div>
            <div v-else-if="createJobsRows.length === 0" style="padding:12px;color:#888;font-size:13px">
              {{ t('templates.createJobsNoAccounts') }}
            </div>
            <div v-else class="create-jobs-list">
              <div v-for="row in createJobsRows" :key="row.account.id" class="create-job-row">
                <div class="create-job-header">
                  <input
                    type="checkbox"
                    :checked="row.selected"
                    :disabled="row.account.authStatus !== 'authenticated'"
                    @change="row.selected = ($event.target as HTMLInputElement).checked"
                  />
                  <span class="create-job-account-name">{{ formatAccountLabel(row.account) }}</span>
                  <span style="font-size:11px;color:#aaa">{{ row.account.phoneNumber }}</span>
                  <span v-if="row.account.authStatus !== 'authenticated'" class="badge badge-grey" style="font-size:10px">
                    {{ t('templates.createJobsNotAuth') }}
                  </span>
                </div>
                <template v-if="row.selected">
                  <div class="form-group" style="margin:6px 0 6px 26px">
                    <label class="form-label" style="font-size:11px">{{ t('templates.createJobsJobName') }}</label>
                    <input v-model.trim="row.name" class="form-input" style="font-size:12px" />
                  </div>
                  <template v-if="createJobsTpl?.jobType === 'embywatch'">
                    <div class="form-row" style="margin-left:26px;margin-bottom:0">
                      <div class="form-group" style="margin-bottom:0">
                        <label class="form-label" style="font-size:11px">{{ t('templates.createJobsEmbyUser') }} <span style="color:#e63946">*</span></label>
                        <input v-model.trim="row.embyUsername" class="form-input" style="font-size:12px" autocomplete="off" />
                      </div>
                      <div class="form-group" style="margin-bottom:0">
                        <label class="form-label" style="font-size:11px">{{ t('templates.createJobsEmbyPass') }} <span style="color:#e63946">*</span></label>
                        <input v-model="row.embyPassword" class="form-input" type="password" style="font-size:12px" autocomplete="new-password" />
                      </div>
                    </div>
                  </template>
                </template>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showCreateJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button
            class="btn btn-primary"
            :disabled="createJobsCreating || createJobsSelectedCount === 0"
            @click="doCreateJobs"
          >
            <i class="fa-solid fa-plus"></i>
            {{ createJobsCreating ? t('templates.createJobsCreating') : t('templates.createJobsConfirm').replace('{n}', String(createJobsSelectedCount)) }}
          </button>
        </div>
      </div>
    </div>

    <!-- Import modal -->
    <div v-if="showImport" class="modal-backdrop">
      <div class="modal" style="width:480px">
        <h3 class="modal-title">{{ t('templates.importTitle') }}</h3>
        <div class="modal-body">
          <div v-if="importError" class="error-msg">{{ importError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t('templates.importLabel') }}</label>
            <textarea
              v-model="importJson"
              class="form-input"
              rows="10"
              style="font-family:monospace;font-size:12px;resize:vertical"
              :placeholder="t('templates.importPlaceholder')"
            />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showImport = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="importing" @click="doImport">
            <i class="fa-solid fa-file-import"></i> {{ importing ? t('common.saving') : t('templates.importConfirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Single delete confirmation -->
    <div v-if="confirmDeleteTplId !== null" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.delete') }}</h3>
        <div class="modal-body">
          <p>{{ t('templates.confirmDelete') }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmDeleteTplId = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeDeleteTpl"><i class="fa-solid fa-trash"></i> {{ t('common.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk disable confirmation -->
    <div v-if="confirmBulkDisableTpls" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('templates.confirmBulkDisable').replace('{n}', String(selectedIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDisableTpls = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDisableTpls"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk delete confirmation -->
    <div v-if="confirmBulkDeleteTpls" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.delete') }}</h3>
        <div class="modal-body">
          <p>{{ t('templates.confirmBulkDelete').replace('{n}', String(selectedIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDeleteTpls = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDeleteTpls"><i class="fa-solid fa-trash"></i> {{ t('common.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- Mobile action sheet -->
    <div v-if="actionMenuTpl" class="action-sheet-backdrop" @click="actionMenuTpl = null">
      <div class="action-sheet" @click.stop>
        <div class="action-sheet-header">{{ actionMenuTpl.name }}</div>
        <button class="action-sheet-btn" @click="openCreateJobs(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-list-check"></i> {{ t('templates.createJobsBtn') }}
        </button>
        <button v-if="(actionMenuTpl.linkedJobCount ?? 0) > 0" class="action-sheet-btn" @click="setLinkedJobsEnabled(actionMenuTpl!, true); actionMenuTpl = null">
          <i class="fa-solid fa-circle-check"></i> {{ t('templates.enableLinkedJobs') }}
        </button>
        <button v-if="(actionMenuTpl.linkedJobCount ?? 0) > 0" class="action-sheet-btn" @click="setLinkedJobsEnabled(actionMenuTpl!, false); actionMenuTpl = null">
          <i class="fa-solid fa-circle-xmark"></i> {{ t('templates.disableLinkedJobs') }}
        </button>
        <button class="action-sheet-btn" @click="shareTemplate(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-share-nodes"></i> {{ t('templates.shareBtn') }}
        </button>
        <button class="action-sheet-btn" @click="duplicateTemplate(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-clone"></i> {{ t('templates.duplicateBtn') }}
        </button>
        <button class="action-sheet-btn" @click="openEdit(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-pen"></i> {{ t('common.edit') }}
        </button>
        <button class="action-sheet-btn danger" @click="openDeleteTpl(actionMenuTpl!.id); actionMenuTpl = null">
          <i class="fa-solid fa-trash"></i> {{ t('common.delete') }}
        </button>
        <div class="action-sheet-divider"></div>
        <button class="action-sheet-btn action-sheet-cancel" @click="actionMenuTpl = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
    <!-- Mute toast -->
    <div v-if="muteToast" class="tpl-toast">{{ muteToast }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { templatesApi, settingsApi, accountsApi, tgClientApi, jobsApi, type JobTemplate, type Settings, type UAPreset, type Proxy, type EmbywatchConfig, type CustomConfig, type CustomAction, type AutoregConfig, type AvailableAccount } from '../api/client';
import { t } from '../i18n';
import { regexValid } from '../utils/regexCheck';
import { usePersistedRef } from '../composables/usePersistedRef';
import { debounce } from '../composables/useDebounce';
import { formatAccountLabel, loadAccountDisplaySetting } from '../composables/accountDisplay';
import PaginationBar from '../components/PaginationBar.vue';
import WebStepsEditor from '../components/WebStepsEditor.vue';
import { webStepsFromConfig, webStepsToConfig, type WebStepForm } from '../composables/webSteps';

type CustomActionForm = {
  type: 'send_command' | 'send_contact_message' | 'wait_reply' | 'delay' | 'click_button' | 'click_message_button' | 'ai_multiple_btn' | 'enter_captcha' | 'join_group' | 'subscribe_channel' | 'open_mini_app' | 'open_mini_app_url' | 'open_bot_menu_app' | 'open_url';
  content: string;
  contentDropdown: string;
  contentCustom: string;
  contentAiInputLength: string;
  maxWaitMs: number;
  waitMs: number;
  gapMs: number;
  button: string;
  buttonDropdown: string;
  buttonCustom: string;
  buttonAiHint: string;
  maxRetries: number;
  scope: number;
  captchaLength: string;
  successContains: string;
  failContains: string;
  cfChallenge: boolean;
  contact: string;
  groupId: string;
  checkMembership: boolean;
  verifyButton: string;
  verifyWaitMs: number;
  channelId: string;
  appButton: string;
  /** open_mini_app: browser budget, 0 = default */
  miniAppMaxWaitMs: number;
  /** open_mini_app: pinned browser proxy id, 'direct', or '' for the job proxy */
  miniAppProxyId: string;
  miniAppTryAllProxies: boolean;
  /** open_url: the page to open */
  url: string;
  /** open_url: sub-steps run on the page once it is up */
  webSteps: WebStepForm[];
};

const templates = ref<JobTemplate[]>([]);
const settings = ref<Settings | null>(null);
const uaPresets = computed<UAPreset[]>(() => {
  try { return JSON.parse(settings.value?.ua_presets ?? '[]'); } catch { return []; }
});
const proxiesList = computed<Proxy[]>(() => {
  try { return JSON.parse(settings.value?.proxies ?? '[]'); } catch { return []; }
});
const aiKeyMissing = computed(() => settings.value?.ai_key_configured !== 'true');
// Anything that opens a page needs the solver's browser and its fonts in the data dir;
// neither ships in the image, so those options stay off until both are downloaded.
// See JobsView: not-yet-loaded settings must not read as a missing browser.
const cfBrowserMissing = computed(
  () =>
    !!settings.value &&
    (settings.value.cf_chromium_installed !== 'true' ||
      settings.value.cf_fonts_installed !== 'true'),
);

const showForm = ref(false);
const editTarget = ref<JobTemplate | null>(null);
const formError = ref('');
const saving = ref(false);
const actionMenuTpl = ref<JobTemplate | null>(null);

const showImport = ref(false);
const importJson = ref('');
const importError = ref('');
const importNotice = ref('');
const importing = ref(false);
const copiedTplId = ref<number | null>(null);

// ── Create jobs from template state ──────────────────────────────────────────
const showCreateJobs = ref(false);
const createJobsTpl = ref<JobTemplate | null>(null);
const createJobsAccounts = ref<AvailableAccount[]>([]);
const createJobsLoading = ref(false);
const createJobsError = ref('');
const createJobsCreating = ref(false);
const createJobsWindowStart = ref(1400);
const createJobsWindowEnd = ref(1600);

type CreateJobRow = {
  account: AvailableAccount;
  selected: boolean;
  name: string;
  embyUsername: string;
  embyPassword: string;
};
const createJobsRows = ref<CreateJobRow[]>([]);

const selectedIds = ref<number[]>([]);
const sharedMulti = ref(false);
const allSelected = computed(() => templates.value.length > 0 && templates.value.every(t => selectedIds.value.includes(t.id)));

const sortKey = usePersistedRef<string>('bemby:templates:sortKey', 'name');
const sortDir = usePersistedRef<'asc' | 'desc'>('bemby:templates:sortDir', 'asc');
const page = ref(1);
const total = ref(0);
const pageSize = usePersistedRef<number>('bemby:templates:pageSize', 25);
const searchText = usePersistedRef<string>('bemby:templates:search', '');

function setSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
  page.value = 1;
  void loadTemplates();
}

function sortIcon(key: string): string {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}

const searchReload = debounce(() => {
  page.value = 1;
  void loadTemplates();
}, 300);
watch(searchText, () => searchReload());

function onPageChange(p: number) {
  page.value = p;
  void loadTemplates();
}
function onPageSizeChange(size: number) {
  // PaginationBar also emits update:page 1, which triggers the reload
  pageSize.value = size;
}
const confirmDeleteTplId = ref<number | null>(null);
const confirmBulkDisableTpls = ref(false);
const confirmBulkDeleteTpls = ref(false);

function toggleAll() {
  selectedIds.value = allSelected.value ? [] : templates.value.map(t => t.id);
}
// Index of the last row toggled without Shift; anchors Shift-click ranges.
let lastSelectedIdx: number | null = null;

function toggleSelect(id: number, idx: number, event?: MouseEvent) {
  // Shift-click selects the contiguous range between the anchor row and this
  // one; other clicks toggle a single row and reset the anchor.
  if (event?.shiftKey && lastSelectedIdx !== null) {
    // Shift-click would otherwise highlight the intervening table text.
    window.getSelection?.()?.removeAllRanges();
    const next = new Set(selectedIds.value);
    const [lo, hi] = [lastSelectedIdx, idx].sort((a, b) => a - b);
    for (let i = lo; i <= hi; i++) {
      const row = templates.value[i];
      if (row) next.add(row.id);
    }
    selectedIds.value = [...next];
    return;
  }
  const arrIdx = selectedIds.value.indexOf(id);
  if (arrIdx === -1) selectedIds.value.push(id);
  else selectedIds.value.splice(arrIdx, 1);
  lastSelectedIdx = idx;
}

// The anchor indexes the current list, so clear it whenever the list is
// replaced (search, filter, reload) to avoid spanning stale rows.
watch(templates, () => {
  lastSelectedIdx = null;
});

const customActions = ref<CustomActionForm[]>([]);
const customJobMaxRetries = ref(1);

const form = reactive({
  name: '',
  jobType: 'checkin' as 'checkin' | 'embywatch' | 'custom' | 'autoreg',
  botUsername: '',
  // Empty means follow the default_timezone setting
  timezone: '',
  replyTimeoutMs: 40000,
  retryMax: 5,
  runEveryDays: 1,
  runEveryDaysMax: null as number | null,
});

// "Run every days" accepts a single number (7) or a range (7-15). Stored as
// runEveryDays (min) + runEveryDaysMax; the scheduler rolls a value in-range.
const runEveryDaysText = ref('1');
function parseRunEvery(text: string): { min: number; max: number | null } {
  const m = String(text).trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return { min: 1, max: null };
  const min = Math.max(1, parseInt(m[1], 10) || 1);
  const hi = m[2] != null ? parseInt(m[2], 10) : NaN;
  return { min, max: Number.isFinite(hi) && hi > min ? hi : null };
}
function formatRunEvery(min: number, max: number | null | undefined): string {
  return max != null && max > min ? `${min}-${max}` : String(min ?? 1);
}
const runEveryDaysValid = computed(() => /^\s*\d+\s*(-\s*\d+\s*)?$/.test(runEveryDaysText.value));

type AutoregCfgForm = {
  groupId: string;
  codePrefix: string;
  codeRegex: string;
  stripChinese: boolean;
  stripChars: string;
  aiModifyCode: boolean;
  aiModifyCodeHint: string;
  aiContextCount: number;
  codeReadyContains: string;
  usernameReadyContains: string;
  entryMode: 'button' | 'command';
  registerButton: string;
  clickAfterCode: boolean;
  afterCodeButton: string;
  afterCodeRequired: boolean;
  signupUsername: string;
  listenMinutes: number;
  scanHistoryCount: number;
  successContains: string;
  failContains: string;
};
function defaultAutoregCfg(): AutoregCfgForm {
  return {
    groupId: '',
    codePrefix: '',
    codeRegex: '',
    stripChinese: false,
    stripChars: '',
    aiModifyCode: false,
    aiModifyCodeHint: '',
    aiContextCount: 6,
    codeReadyContains: '',
    usernameReadyContains: '',
    entryMode: 'button',
    registerButton: '',
    clickAfterCode: false,
    afterCodeButton: '',
    afterCodeRequired: false,
    signupUsername: '',
    listenMinutes: 30,
    scanHistoryCount: 0,
    successContains: '',
    failContains: '',
  };
}
const autoregCfg = reactive<AutoregCfgForm>(defaultAutoregCfg());

const embyCfg = reactive<{ username: string; password: string; playDuration: number | string; userAgent: string; markWatched: boolean; verifyPlayable: boolean; realWatch: boolean; sequencePlay: boolean; library: string }>({
  username: '',
  password: '',
  playDuration: '',
  userAgent: '',
  markWatched: true,
  verifyPlayable: true,
  realWatch: false,
  sequencePlay: false,
  library: '',
});
const tplProxyId = ref('');
const embyUaDropdown = ref('');
const embyServer = reactive<{ protocol: 'https' | 'http'; host: string; port: number | '' }>({
  protocol: 'https',
  host: '',
  port: 443,
});

const CMD_PRESETS = new Set(['', '/start', '/checkin']);
const ACTION_CMD_PRESETS = new Set(['/start', '/checkin']);
const ACTION_BTN_PRESETS = new Set(['签到', '{anyBtn}']);
const BTN_PRESETS = new Set(['', '签到', '{aiBtn}', '{anyBtn}']);
const cmdDropdown = ref('');
const cmdCustom = ref('');
const btnDropdown = ref('');
const btnCustom = ref('');
const btnAiHint = ref('');
const tplCheckinSuccessContains = ref('');
const tplCheckinFailContains = ref('');
const tplCheckinCfChallenge = ref(false);

function setCmdState(val: string) {
  if (CMD_PRESETS.has(val)) { cmdDropdown.value = val; cmdCustom.value = ''; }
  else { cmdDropdown.value = 'custom'; cmdCustom.value = val; }
}

function setBtnState(val: string) {
  const aiMatch = val.match(/^\{aiBtn:(.+)\}$/);
  if (aiMatch) {
    btnDropdown.value = '{aiBtn}'; btnAiHint.value = aiMatch[1].trim(); btnCustom.value = '';
  } else if (BTN_PRESETS.has(val)) {
    btnDropdown.value = val; btnCustom.value = ''; btnAiHint.value = '';
  } else {
    btnDropdown.value = 'custom'; btnCustom.value = val; btnAiHint.value = '';
  }
}

function setUaState(ua: string) {
  if (!ua) { embyUaDropdown.value = ''; return; }
  const match = uaPresets.value.find(p => p.value === ua);
  embyUaDropdown.value = match ? match.name : '__custom__';
}

function onUaDropdownChange() {
  if (embyUaDropdown.value === '') { embyCfg.userAgent = ''; return; }
  if (embyUaDropdown.value === '__custom__') return;
  const preset = uaPresets.value.find(p => p.name === embyUaDropdown.value);
  if (preset) embyCfg.userAgent = preset.value;
}

function onJobTypeChange() {
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  tplProxyId.value = '';
  customActions.value = [];
  customJobMaxRetries.value = 1;
  btnAiHint.value = '';
  tplCheckinSuccessContains.value = '';
  tplCheckinFailContains.value = '';
  tplCheckinCfChallenge.value = false;
  Object.assign(autoregCfg, defaultAutoregCfg());
  setCmdState(''); setBtnState('');
}

function defaultAction(): CustomActionForm {
  return {
    type: 'send_command', content: '/start', contentDropdown: '/start', contentCustom: '',
    contentAiInputLength: '', maxWaitMs: 30000, waitMs: 2000, gapMs: 1000, button: '签到',
    buttonDropdown: '签到', buttonCustom: '', buttonAiHint: '', maxRetries: 3, scope: 0,
    captchaLength: '', successContains: '', failContains: '', cfChallenge: false, contact: '', groupId: '', checkMembership: false,
    verifyButton: '', verifyWaitMs: 30000, channelId: '', appButton: '',
    miniAppMaxWaitMs: 300000, miniAppProxyId: '', miniAppTryAllProxies: true,
    url: '', webSteps: [],
  };
}

function addAction() { customActions.value.push(defaultAction()); }
function removeAction(i: number) { customActions.value.splice(i, 1); }
function moveUp(i: number) {
  if (i === 0) return;
  const arr = customActions.value;
  [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
}
function moveDown(i: number) {
  const arr = customActions.value;
  if (i >= arr.length - 1) return;
  [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
}

function jobTypeBadge(type: string) {
  const map: Record<string, string> = {
    checkin: 'badge badge-blue',
    embywatch: 'badge badge-purple',
    custom: 'badge badge-amber',
    autoreg: 'badge badge-red',
  };
  return map[type] ?? 'badge badge-grey';
}

function handleEmbyHostPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.trim();
  if (!text) return;
  const match = text.match(/^(?:(https?):\/\/)?([^:/\s]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!match) return;
  const [, proto, host, portStr] = match;
  if (!proto && !portStr) return;
  event.preventDefault();
  if (proto === 'https' || proto === 'http') embyServer.protocol = proto as 'https' | 'http';
  embyServer.host = host;
  if (portStr) embyServer.port = Number(portStr);
}

function buildConfig(): EmbywatchConfig | CustomConfig | AutoregConfig | null {
  if (form.jobType === 'autoreg') {
    const cfg: AutoregConfig = {
      groupId: autoregCfg.groupId,
      codePrefix: autoregCfg.codePrefix,
      signupUsername: autoregCfg.signupUsername,
    };
    if (autoregCfg.entryMode === 'command') cfg.entryMode = 'command';
    else if (autoregCfg.registerButton.trim()) cfg.registerButton = autoregCfg.registerButton.trim();
    if (autoregCfg.listenMinutes > 0 && autoregCfg.listenMinutes !== 30) cfg.listenMinutes = autoregCfg.listenMinutes;
    if (autoregCfg.scanHistoryCount > 0) cfg.scanHistoryCount = autoregCfg.scanHistoryCount;
    if (autoregCfg.codeRegex.trim()) cfg.codeRegex = autoregCfg.codeRegex.trim();
    if (autoregCfg.stripChinese) cfg.stripChinese = true;
    if (autoregCfg.stripChars.trim()) cfg.stripChars = autoregCfg.stripChars.trim();
    if (autoregCfg.aiModifyCode) {
      cfg.aiModifyCode = true;
      if (autoregCfg.aiModifyCodeHint.trim()) cfg.aiModifyCodeHint = autoregCfg.aiModifyCodeHint.trim();
      if (autoregCfg.aiContextCount >= 0 && autoregCfg.aiContextCount !== 6) cfg.aiContextCount = autoregCfg.aiContextCount;
    }
    if (autoregCfg.codeReadyContains.trim()) cfg.codeReadyContains = autoregCfg.codeReadyContains.trim();
    if (autoregCfg.clickAfterCode) {
      cfg.clickAfterCode = true;
      if (autoregCfg.afterCodeButton.trim()) cfg.afterCodeButton = autoregCfg.afterCodeButton.trim();
      if (autoregCfg.afterCodeRequired) cfg.afterCodeRequired = true;
    }
    if (autoregCfg.usernameReadyContains.trim()) cfg.usernameReadyContains = autoregCfg.usernameReadyContains.trim();
    if (autoregCfg.successContains.trim()) cfg.successContains = autoregCfg.successContains.trim();
    if (autoregCfg.failContains.trim()) cfg.failContains = autoregCfg.failContains.trim();
    if (tplProxyId.value) cfg.proxyId = tplProxyId.value;
    return cfg;
  }
  if (form.jobType === 'embywatch') {
    // Credentials (username/password) are job-specific; template only stores playback settings
    const cfg: Partial<EmbywatchConfig> = {};
    if (embyCfg.playDuration !== '') cfg.playDuration = Number(embyCfg.playDuration as string | number);
    if (embyCfg.userAgent) cfg.userAgent = embyCfg.userAgent;
    cfg.markWatched = embyCfg.markWatched;
    cfg.verifyPlayable = embyCfg.verifyPlayable;
    cfg.realWatch = embyCfg.realWatch;
    cfg.sequencePlay = embyCfg.sequencePlay;
    if (embyCfg.library) cfg.library = embyCfg.library;
    if (tplProxyId.value) cfg.proxyId = tplProxyId.value;
    return cfg as EmbywatchConfig;
  }
  if (form.jobType === 'custom') {
    const cfg: CustomConfig = {
      actions: customActions.value.map(a => {
        if (a.type === 'send_command') {
          let content: string;
          if (a.contentDropdown === '{aiInput}') {
            content = a.contentAiInputLength ? `{aiInput:${a.contentAiInputLength}}` : '{aiInput}';
          } else {
            content = a.contentDropdown === 'custom' ? a.contentCustom : a.contentDropdown;
          }
          return { type: 'send_command' as const, content, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'send_contact_message') {
          let content: string;
          if (a.contentDropdown === '{aiInput}') {
            content = a.contentAiInputLength ? `{aiInput:${a.contentAiInputLength}}` : '{aiInput}';
          } else {
            content = a.contentDropdown === 'custom' ? a.contentCustom : a.contentDropdown;
          }
          return { type: 'send_contact_message' as const, contact: a.contact, content, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'wait_reply') {
          return {
            type: 'wait_reply' as const,
            maxWaitMs: a.maxWaitMs,
            ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
            ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
            ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
            ...(a.scope ? { scope: a.scope } : {}),
          };
        }
        if (a.type === 'delay') return { type: 'delay' as const, waitMs: a.waitMs };
        if (a.type === 'enter_captcha') {
          const captchaLength = a.captchaLength ? parseInt(a.captchaLength) || undefined : undefined;
          return { type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'join_group') return {
          type: 'join_group' as const,
          groupId: a.groupId,
          ...(a.checkMembership ? { checkMembership: true } : {}),
          ...(a.verifyButton.trim() ? { verifyButton: a.verifyButton.trim(), verifyWaitMs: a.verifyWaitMs } : {}),
        };
        if (a.type === 'subscribe_channel') return { type: 'subscribe_channel' as const, channelId: a.channelId, ...(a.checkMembership ? { checkMembership: true } : {}) };
        if (a.type === 'open_mini_app') return {
          type: 'open_mini_app' as const,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.button.trim() ? { button: a.button.trim() } : {}),
          ...(a.appButton.trim() ? { appButtons: a.appButton.split(/->|>/).map(x => x.trim()).filter(Boolean) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        if (a.type === 'open_mini_app_url') return {
          type: 'open_mini_app_url' as const,
          url: a.url.trim(),
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.appButton.trim() ? { appButtons: a.appButton.split(/->|>/).map(x => x.trim()).filter(Boolean) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        if (a.type === 'open_bot_menu_app') return {
          type: 'open_bot_menu_app' as const,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.appButton.trim() ? { appButtons: a.appButton.split(/->|>/).map(x => x.trim()).filter(Boolean) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        if (a.type === 'open_url') return {
          type: 'open_url' as const,
          url: a.url.trim(),
          ...(a.webSteps.length ? { steps: webStepsToConfig(a.webSteps) } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...(a.miniAppProxyId ? { proxyId: a.miniAppProxyId } : {}),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        };
        if (a.type === 'ai_multiple_btn') return {
          type: 'ai_multiple_btn' as const,
          gapMs: a.gapMs,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.buttonAiHint.trim() ? { hint: a.buttonAiHint.trim() } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
        };
        let button: string;
        if (a.buttonDropdown === 'custom') button = a.buttonCustom;
        else if (a.buttonDropdown === '{aiBtn}') button = a.buttonAiHint.trim() ? `{aiBtn:${a.buttonAiHint.trim()}}` : '{aiBtn}';
        else button = a.buttonDropdown || '签到';
        if (a.type === 'click_message_button') return {
          type: 'click_message_button' as const,
          contact: a.contact,
          button,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
          ...(a.cfChallenge ? { cfChallenge: true } : {}),
        };
        return {
          type: 'click_button' as const,
          button,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
          ...(a.cfChallenge ? { cfChallenge: true } : {}),
        };
      }),
    };
    if (customJobMaxRetries.value > 1) cfg.maxRetries = customJobMaxRetries.value;
    if (tplProxyId.value) cfg.proxyId = tplProxyId.value;
    return cfg;
  }
  if (form.jobType === 'checkin') {
    const s = tplCheckinSuccessContains.value.trim();
    const f = tplCheckinFailContains.value.trim();
    const proxy = tplProxyId.value;
    const cf = tplCheckinCfChallenge.value;
    if (s || f || proxy || cf) return {
      ...(s ? { successContains: s } : {}),
      ...(f ? { failContains: f } : {}),
      ...(proxy ? { proxyId: proxy } : {}),
      ...(cf ? { cfChallenge: true } : {}),
    } as unknown as CustomConfig;
    return null;
  }
  return null;
}

onMounted(async () => {
  loadAccountDisplaySetting();
  await Promise.all([loadTemplates(), loadSettings()]);
});

async function loadTemplates(): Promise<void> {
  const search = searchText.value.trim();
  // While searching on the default sort, let the server rank by fuzzy relevance
  const defaultSort = sortKey.value === 'name' && sortDir.value === 'asc';
  const res = await templatesApi.listPaged({
    page: page.value,
    pageSize: pageSize.value,
    search: search || undefined,
    sortKey: search && defaultSort ? undefined : sortKey.value || undefined,
    sortDir: search && defaultSort ? undefined : sortDir.value,
  });
  // Step back a page when the current one empties out (e.g. after bulk delete)
  if (!res.items.length && page.value > 1) {
    page.value -= 1;
    return loadTemplates();
  }
  templates.value = res.items;
  total.value = res.total;
  // Prune selections that are no longer on the visible page
  const visible = new Set(res.items.map(t => t.id));
  selectedIds.value = selectedIds.value.filter(id => visible.has(id));
}

async function loadSettings() {
  try { settings.value = await settingsApi.get(); } catch { /* ignore */ }
}

function openAdd() {
  // See JobsView: the browser may have been installed since this view mounted
  void loadSettings();
  editTarget.value = null;
  Object.assign(form, {
    name: '',
    jobType: 'checkin',
    botUsername: '',
    timezone: '',
    replyTimeoutMs: 40000,
    retryMax: Number(settings.value?.default_max_retry ?? 5),
    runEveryDays: 1,
    runEveryDaysMax: null,
  });
  runEveryDaysText.value = '1';
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  tplProxyId.value = '';
  customActions.value = [];
  customJobMaxRetries.value = 1;
  tplCheckinSuccessContains.value = '';
  tplCheckinFailContains.value = '';
  tplCheckinCfChallenge.value = false;
  Object.assign(autoregCfg, defaultAutoregCfg());
  setCmdState(''); setBtnState('');
  formError.value = '';
  showForm.value = true;
}

function openEdit(tpl: JobTemplate) {
  void loadSettings();
  editTarget.value = tpl;
  Object.assign(form, {
    name: tpl.name,
    jobType: tpl.jobType,
    botUsername: tpl.botUsername,
    timezone: tpl.timezone,
    replyTimeoutMs: tpl.replyTimeoutMs,
    retryMax: tpl.retryMax,
    runEveryDays: tpl.runEveryDays ?? 1,
    runEveryDaysMax: tpl.runEveryDaysMax ?? null,
  });
  runEveryDaysText.value = formatRunEvery(tpl.runEveryDays ?? 1, tpl.runEveryDaysMax);
  setCmdState(tpl.startCommand === '/start' ? '' : (tpl.startCommand ?? ''));
  setBtnState(tpl.checkinButton === '签到' ? '' : (tpl.checkinButton ?? ''));

  tplProxyId.value = '';
  if (tpl.jobType === 'embywatch') {
    const m = tpl.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, {
      protocol: (m?.[1] ?? 'https') as 'https' | 'http',
      host: m?.[2] ?? tpl.botUsername,
      port: m?.[3] ? Number(m[3]) : 443,
    });
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as EmbywatchConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
        Object.assign(embyCfg, {
          username: '',
          password: '',
          playDuration: c.playDuration ?? '',
          userAgent: c.userAgent ?? '',
          markWatched: c.markWatched !== false,
          verifyPlayable: c.verifyPlayable !== false,
          realWatch: c.realWatch === true,
          sequencePlay: c.sequencePlay === true,
          library: c.library ?? '',
        });
        tplProxyId.value = c.proxyId ?? '';
        setUaState(c.userAgent ?? '');
      } catch {
        Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
        embyUaDropdown.value = '';
      }
    } else {
      Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
      embyUaDropdown.value = '';
    }
  } else if (tpl.jobType === 'custom') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (tpl.config) {
      try {
        const cfg = JSON.parse(tpl.config) as CustomConfig & { proxyId?: string };
        tplProxyId.value = cfg.proxyId ?? '';
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = cfg.actions.map((a: CustomAction) => {
          const base = defaultAction();
          if (a.type === 'send_command') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) {
              return { ...base, type: 'send_command' as const, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            }
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_command' as const, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'send_contact_message') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) {
              return { ...base, type: 'send_contact_message' as const, contact: a.contact, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            }
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_contact_message' as const, contact: a.contact, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'wait_reply') return { ...base, type: 'wait_reply' as const, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, scope: a.scope ?? 0 };
          if (a.type === 'delay') return { ...base, type: 'delay' as const, waitMs: a.waitMs };
          if (a.type === 'enter_captcha') return { ...base, type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength: String(a.captchaLength ?? ''), maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'join_group') return { ...base, type: 'join_group' as const, groupId: a.groupId, checkMembership: a.checkMembership ?? false, verifyButton: a.verifyButton ?? '', verifyWaitMs: a.verifyWaitMs ?? 30000 };
          if (a.type === 'subscribe_channel') return { ...base, type: 'subscribe_channel' as const, channelId: a.channelId, checkMembership: a.checkMembership ?? false };
          if (a.type === 'open_mini_app') return { ...base, type: 'open_mini_app' as const, contact: a.contact ?? '', button: a.button ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_mini_app_url') return { ...base, type: 'open_mini_app_url' as const, url: a.url ?? '', contact: a.contact ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_bot_menu_app') return { ...base, type: 'open_bot_menu_app' as const, contact: a.contact ?? '', appButton: (a.appButtons ?? []).join(' > '), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'open_url') return { ...base, type: 'open_url' as const, url: a.url ?? '', webSteps: webStepsFromConfig(a.steps), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppTryAllProxies: a.tryAllProxies ?? true };
          if (a.type === 'ai_multiple_btn') return { ...base, type: 'ai_multiple_btn' as const, contact: a.contact ?? '', buttonAiHint: a.hint ?? '', gapMs: a.gapMs ?? 1000, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0 };
          if (a.type === 'click_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) {
              buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? '';
            } else if (ACTION_BTN_PRESETS.has(a.button)) {
              buttonDropdown = a.button;
            } else {
              buttonDropdown = 'custom'; buttonCustom = a.button;
            }
            return { ...base, type: 'click_button' as const, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0, cfChallenge: a.cfChallenge ?? false };
          }
          if (a.type === 'click_message_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) {
              buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? '';
            } else if (ACTION_BTN_PRESETS.has(a.button)) {
              buttonDropdown = a.button;
            } else {
              buttonDropdown = 'custom'; buttonCustom = a.button;
            }
            return { ...base, type: 'click_message_button' as const, contact: a.contact, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0, cfChallenge: a.cfChallenge ?? false };
          }
          return base;
        });
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    } else {
      customActions.value = [];
      customJobMaxRetries.value = 1;
    }
  } else if (tpl.jobType === 'autoreg') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
    Object.assign(autoregCfg, defaultAutoregCfg());
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as (AutoregConfig & { proxyId?: string }) | string;
        if (typeof c === 'string') c = JSON.parse(c) as AutoregConfig & { proxyId?: string };
        tplProxyId.value = c.proxyId ?? '';
        Object.assign(autoregCfg, {
          groupId: c.groupId ?? '',
          codePrefix: c.codePrefix ?? '',
          codeRegex: c.codeRegex ?? '',
          stripChinese: c.stripChinese === true,
          stripChars: c.stripChars ?? '',
          aiModifyCode: c.aiModifyCode === true,
          aiModifyCodeHint: c.aiModifyCodeHint ?? '',
          aiContextCount: c.aiContextCount ?? 6,
          codeReadyContains: c.codeReadyContains ?? '',
          usernameReadyContains: c.usernameReadyContains ?? '',
          registerButton: c.registerButton ?? '',
          clickAfterCode: c.clickAfterCode === true,
          afterCodeButton: c.afterCodeButton ?? '',
          afterCodeRequired: c.afterCodeRequired === true,
          signupUsername: c.signupUsername ?? '',
          listenMinutes: c.listenMinutes ?? 30,
          scanHistoryCount: c.scanHistoryCount ?? 0,
          entryMode: c.entryMode === 'command' ? 'command' : 'button',
          successContains: c.successContains ?? '',
          failContains: c.failContains ?? '',
        });
      } catch { /* ignore */ }
    }
  } else {
    // checkin
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '' });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
    tplCheckinSuccessContains.value = '';
    tplCheckinFailContains.value = '';
    if (tpl.config) {
      try {
        const cfg = JSON.parse(tpl.config) as { proxyId?: string; successContains?: string; failContains?: string; cfChallenge?: boolean };
        tplProxyId.value = cfg.proxyId ?? '';
        tplCheckinSuccessContains.value = cfg.successContains ?? '';
        tplCheckinFailContains.value = cfg.failContains ?? '';
        tplCheckinCfChallenge.value = cfg.cfChallenge ?? false;
      } catch { /* ignore */ }
    }
  }
  formError.value = '';
  showForm.value = true;
}

async function saveTemplate() {
  formError.value = '';
  if (!form.name) { formError.value = t('jobs.errors.nameRequired'); return; }
  if (form.jobType === 'custom') {
    // No target bot needed: an action can name its own contact, or drive a page that
    // never touches Telegram. The ones that do need it say so when they run.
    if (customActions.value.length === 0) { formError.value = t('jobs.errors.customActionsRequired'); return; }
  }
  if (form.jobType === 'embywatch') {
    if (!embyServer.host) { formError.value = t('jobs.errors.hostRequired'); return; }
    const portPart = (embyServer.port as number | string) !== '' ? `:${embyServer.port}` : '';
    form.botUsername = `${embyServer.protocol}://${embyServer.host.replace(/^https?:\/\//, '')}${portPart}`;
    // Credentials are set per-job, not in the template
  }
  if (form.jobType === 'autoreg') {
    if (!form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
    if (!autoregCfg.groupId) { formError.value = t('jobs.errors.autoregGroupRequired'); return; }
    if (!autoregCfg.codePrefix && !autoregCfg.codeRegex) { formError.value = t('jobs.errors.autoregPrefixRequired'); return; }
    if (autoregCfg.codeRegex && !regexValid(autoregCfg.codeRegex)) { formError.value = t('jobs.errors.autoregRegexInvalid'); return; }
    if (!autoregCfg.signupUsername) { formError.value = t('jobs.errors.autoregUsernameRequired'); return; }
  }
  if (form.jobType === 'checkin' && !form.botUsername) {
    formError.value = t('jobs.errors.botRequired');
    return;
  }
  if (form.jobType === 'checkin' || form.jobType === 'autoreg') form.botUsername = form.botUsername.replace(/^@+/, '');

  saving.value = true;
  try {
    const rawCfg = buildConfig();
    const startCommand = (cmdDropdown.value === 'custom' ? cmdCustom.value : cmdDropdown.value) || undefined;
    const resolvedAiBtn = btnAiHint.value.trim() ? `{aiBtn:${btnAiHint.value.trim()}}` : '{aiBtn}';
    const checkinButton = btnDropdown.value === '{aiBtn}'
      ? resolvedAiBtn
      : (btnDropdown.value === 'custom' ? btnCustom.value : btnDropdown.value) || undefined;
    const re = parseRunEvery(runEveryDaysText.value);
    form.runEveryDays = re.min;
    form.runEveryDaysMax = re.max;
    const payload = {
      ...form,
      // config is serialised by the backend; pass as-is
      config: rawCfg as unknown as string | null,
      startCommand,
      checkinButton,
    };
    if (editTarget.value) {
      await templatesApi.update(editTarget.value.id, payload);
    } else {
      await templatesApi.create(payload);
    }
    showForm.value = false;
    await loadTemplates();
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function setLinkedJobsEnabled(tpl: JobTemplate, enabled: boolean) {
  await templatesApi.setLinkedJobsEnabled(tpl.id, enabled);
}

async function openCreateJobs(tpl: JobTemplate) {
  createJobsTpl.value = tpl;
  createJobsError.value = '';
  createJobsLoading.value = true;
  createJobsRows.value = [];
  showCreateJobs.value = true;
  try {
    createJobsAccounts.value = await templatesApi.availableAccounts(tpl.id);
    createJobsRows.value = createJobsAccounts.value.map(a => ({
      account: a,
      selected: a.authStatus === 'authenticated',
      name: `${tpl.name} - ${a.name}`,
      embyUsername: '',
      embyPassword: '',
    }));
  } catch (err: any) {
    createJobsError.value = err.response?.data?.error ?? 'Failed to load accounts';
  } finally {
    createJobsLoading.value = false;
  }
}

const createJobsSelectedCount = computed(() => createJobsRows.value.filter(r => r.selected).length);

function createJobsSelectAll() {
  createJobsRows.value.forEach(r => { if (r.account.authStatus === 'authenticated') r.selected = true; });
}

function createJobsDeselectAll() {
  createJobsRows.value.forEach(r => { r.selected = false; });
}

async function doCreateJobs() {
  if (!createJobsTpl.value) return;
  const selected = createJobsRows.value.filter(r => r.selected);
  if (!selected.length) return;

  // Validate embywatch credentials
  if (createJobsTpl.value.jobType === 'embywatch') {
    for (const r of selected) {
      if (!r.embyUsername.trim() || !r.embyPassword.trim()) {
        createJobsError.value = `${r.account.name}: Emby username and password are required`;
        return;
      }
    }
  }

  createJobsError.value = '';
  createJobsCreating.value = true;
  try {
    // Verify server reachability and each account's credentials before creating
    if (createJobsTpl.value.jobType === 'embywatch') {
      let tplCfg: { proxyId?: string; userAgent?: string } = {};
      try {
        if (createJobsTpl.value.config) tplCfg = JSON.parse(createJobsTpl.value.config);
      } catch { /* ignore bad template config */ }
      for (const r of selected) {
        const test = await jobsApi.testEmby({
          serverUrl: createJobsTpl.value.botUsername,
          username: r.embyUsername.trim(),
          password: r.embyPassword.trim(),
          ...(tplCfg.userAgent ? { userAgent: tplCfg.userAgent } : {}),
          ...(tplCfg.proxyId ? { proxyId: tplCfg.proxyId } : {}),
        });
        if (!test.ok) {
          createJobsError.value = `${r.account.name}: ${t('jobs.errors.embyVerifyFailed')}${test.error ? `: ${test.error}` : ''}`;
          return;
        }
      }
    }
    const jobs = selected.map(r => ({
      accountId: r.account.id,
      name: r.name.trim() || `${createJobsTpl.value!.name} - ${r.account.name}`,
      ...(createJobsTpl.value!.jobType === 'embywatch'
        ? { config: { username: r.embyUsername.trim(), password: r.embyPassword.trim() } }
        : {}),
    }));
    const result = await templatesApi.createJobs(createJobsTpl.value.id, {
      jobs,
      scheduleWindowStart: Number(createJobsWindowStart.value),
      scheduleWindowEnd: Number(createJobsWindowEnd.value),
    });
    showCreateJobs.value = false;
    alert(t('templates.createJobsSuccess').replace('{n}', String(result.created)));
    await loadTemplates();
  } catch (err: any) {
    createJobsError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    createJobsCreating.value = false;
  }
}

function openDeleteTpl(id: number) {
  confirmDeleteTplId.value = id;
}

async function executeDeleteTpl() {
  const id = confirmDeleteTplId.value;
  if (!id) return;
  await templatesApi.delete(id);
  confirmDeleteTplId.value = null;
  selectedIds.value = selectedIds.value.filter(i => i !== id);
  await loadTemplates();
}

async function duplicateTemplate(tpl: JobTemplate) {
  if (duplicatingId.value) return;
  duplicatingId.value = tpl.id;
  try {
    const copy = await templatesApi.duplicate(tpl.id);
    await loadTemplates();
    showToast(t('templates.duplicated').replace('{name}', copy.name));
  } catch (err: any) {
    showToast(err.response?.data?.error ?? t('common.saveFailed'));
  } finally {
    duplicatingId.value = null;
  }
}

async function toggleTemplateEnabled(tpl: JobTemplate) {
  await templatesApi.update(tpl.id, { enabled: !tpl.enabled });
  await loadTemplates();
}

async function bulkEnableTpls() {
  await Promise.all(selectedIds.value.map(id => templatesApi.update(id, { enabled: true })));
  await loadTemplates();
  selectedIds.value = [];
}

async function executeBulkDisableTpls() {
  await Promise.all(selectedIds.value.map(id => templatesApi.update(id, { enabled: false })));
  await loadTemplates();
  confirmBulkDisableTpls.value = false;
  selectedIds.value = [];
}

async function executeBulkDeleteTpls() {
  await Promise.all(selectedIds.value.map(id => templatesApi.delete(id)));
  await loadTemplates();
  confirmBulkDeleteTpls.value = false;
  selectedIds.value = [];
}

const muteToast = ref('');
const isMutingBot = ref(false);
const duplicatingId = ref<number | null>(null);
let muteToastTimer: ReturnType<typeof setTimeout> | null = null;

/** Brief message in the corner, shared by anything that finishes without a dialog. */
function showToast(message: string) {
  muteToast.value = message;
  if (muteToastTimer) clearTimeout(muteToastTimer);
  muteToastTimer = setTimeout(() => { muteToast.value = ''; }, 3000);
}

// ~15 calls/min -- safe for Telegram's account.UpdateNotifySettings
const MUTE_RATE_MS = 4000;

async function bulkMuteBotForever() {
  if (isMutingBot.value) return;

  const botUsernames = [...new Set(
    templates.value
      .filter(t => selectedIds.value.includes(t.id) && t.botUsername)
      .map(t => t.botUsername)
  )];
  if (!botUsernames.length) return;

  const accounts = (await accountsApi.list()).filter(a => !a.disabled);
  const MUTE_FOREVER = 365 * 24 * 3600;
  const pairs = accounts.flatMap(acc => botUsernames.map(bot => ({ acc, bot })));

  isMutingBot.value = true;
  if (muteToastTimer) clearTimeout(muteToastTimer);

  for (let i = 0; i < pairs.length; i++) {
    const { acc, bot } = pairs[i];
    muteToast.value = t('templates.bulkMutingProgress')
      .replace('{done}', String(i + 1))
      .replace('{total}', String(pairs.length));
    try {
      await tgClientApi.mute(acc.id, bot, MUTE_FOREVER);
    } catch { /* continue on individual failure */ }
    if (i < pairs.length - 1) {
      await new Promise(resolve => setTimeout(resolve, MUTE_RATE_MS));
    }
  }

  isMutingBot.value = false;
  showToast(t('templates.bulkMuteBotForeverDone'));
}

const SHARE_KEYS: (keyof JobTemplate)[] = ['name', 'jobType', 'botUsername', 'timezone', 'replyTimeoutMs', 'retryMax', 'config'];

// The start command and the button are stored on every template, defaulted, but only these
// job types read them -- a custom or embywatch template shared with them in tow reads as if
// it sends "/start" and looks for "签到", which it never does.
const SHARE_KEYS_BY_TYPE: Partial<Record<JobTemplate['jobType'], (keyof JobTemplate)[]>> = {
  checkin: ['startCommand', 'checkinButton'],
  autoreg: ['startCommand'],
};

function shareShape(tpl: JobTemplate): Record<string, unknown> {
  const keys = [...SHARE_KEYS, ...(SHARE_KEYS_BY_TYPE[tpl.jobType] ?? [])];
  return Object.fromEntries(keys.map(k => [k, tpl[k]]));
}

async function shareSelected() {
  const selected = templates.value.filter(t => selectedIds.value.includes(t.id));
  const text = JSON.stringify(selected.map(shareShape), null, 2);
  await writeClipboard(text);
  sharedMulti.value = true;
  setTimeout(() => { sharedMulti.value = false; }, 1500);
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
}

async function shareTemplate(tpl: JobTemplate) {
  const text = JSON.stringify(shareShape(tpl), null, 2);
  await writeClipboard(text);
  copiedTplId.value = tpl.id;
  setTimeout(() => { copiedTplId.value = null; }, 1500);
}

function openImport() {
  importJson.value = '';
  importError.value = '';
  importNotice.value = '';
  showImport.value = true;
}

// A shared template carries `proxyId`, which only means something next to the proxy list
// it came from. Keeping one this instance does not have would silently run the job with no
// proxy at all, so it is dropped and reported.
function normaliseImportItem(item: Record<string, unknown>): { item: Record<string, unknown>; droppedProxy: boolean } {
  if (typeof item.config === 'string') {
    try { item.config = JSON.parse(item.config); } catch { /* leave as-is */ }
  }
  let droppedProxy = false;
  const cfg = item.config as Record<string, unknown> | null | undefined;
  const proxyId = cfg && typeof cfg === 'object' ? cfg.proxyId : undefined;
  if (typeof proxyId === 'string' && proxyId && !proxiesList.value.some((p) => p.id === proxyId)) {
    delete (cfg as Record<string, unknown>).proxyId;
    droppedProxy = true;
  }
  return { item, droppedProxy };
}

async function doImport() {
  importError.value = '';
  let raw: unknown;
  try {
    raw = JSON.parse(importJson.value);
  } catch {
    importError.value = t('templates.importError');
    return;
  }

  const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : [raw as Record<string, unknown>];
  if (!items.length || !('name' in items[0]) || !('jobType' in items[0])) {
    importError.value = t('templates.importError');
    return;
  }

  importing.value = true;
  try {
    let droppedProxies = 0;
    for (const item of items) {
      const { item: normalised, droppedProxy } = normaliseImportItem(item);
      if (droppedProxy) droppedProxies++;
      await templatesApi.create(normalised as Partial<JobTemplate>);
    }
    showImport.value = false;
    if (droppedProxies) {
      importNotice.value = t('templates.importProxyDropped').replace('{n}', String(droppedProxies));
    }
    await loadTemplates();
  } catch (err: any) {
    importError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped>
.th-sort {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.th-sort:hover {
  background: #f0f4ff;
}

.th-sort.sort-active {
  color: #3730a3;
}

tbody tr:nth-child(even):not(.row-selected) td {
  background: #f0f2f5;
}

.row-selected td {
  background: #bfdbfe;
}

.sort-icon {
  font-size: 10px;
  color: #ccc;
  margin-left: 2px;
}

.th-sort.sort-active .sort-icon {
  color: #6366f1;
}

.custom-action-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fafafa;
}

.custom-action-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.custom-action-num {
  min-width: 20px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: #aaa;
}

.custom-action-type-select {
  flex: 1;
}

.custom-action-params {
  padding-left: 26px;
}

.action-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.action-sheet {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
}

.action-sheet-header {
  padding: 14px 20px 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  border-bottom: 1px solid #f0f0f0;
}

.action-sheet-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 15px 20px;
  background: none;
  border: none;
  font-size: 15px;
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.action-sheet-btn:not(:disabled):active {
  background: #f5f5f5;
}

.action-sheet-btn.danger {
  color: #e63946;
}

.action-sheet-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-sheet-divider {
  height: 1px;
  background: #f0f0f0;
  margin: 4px 0;
}

.action-sheet-cancel {
  color: #888;
  font-weight: 500;
}

.create-jobs-list {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
}

.create-job-row {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
}

.create-job-row:last-child {
  border-bottom: none;
}

.create-job-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.create-job-account-name {
  font-weight: 500;
  font-size: 13px;
  flex: 1;
}

.tpl-toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(26, 26, 46, 0.88);
  color: #fff;
  font-size: 13px;
  padding: 8px 20px;
  border-radius: 20px;
  pointer-events: none;
  z-index: 9999;
  white-space: nowrap;
  animation: tpl-fade-in 0.15s ease;
}

@keyframes tpl-fade-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
