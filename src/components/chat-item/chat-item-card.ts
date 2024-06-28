/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { DomBuilder, DomBuilderObject, ExtendedHTMLElement } from '../../helper/dom';
import { MynahUIGlobalEvents } from '../../helper/events';
import { MynahUITabsStore } from '../../helper/tabs-store';
import { CardRenderDetails, ChatItem, ChatItemType, MynahEventNames } from '../../static';
import { Card } from '../card/card';
import { CardBody, CardBodyProps } from '../card/card-body';
import { Icon, MynahIcons } from '../icon';
import { ChatItemFollowUpContainer } from './chat-item-followup';
import { ChatItemSourceLinksContainer } from './chat-item-source-links';
import { ChatItemRelevanceVote } from './chat-item-relevance-vote';
import { ChatItemTreeViewWrapper } from './chat-item-tree-view-wrapper';
import { Config } from '../../helper/config';
import { generateUID } from '../../helper/guid';
import { ChatItemFormItemsWrapper } from './chat-item-form-items';
import { ChatItemButtonsWrapper } from './chat-item-buttons';
import { cleanHtml } from '../../helper/sanitize';
import { CONTAINER_GAP } from './chat-wrapper';
import { chatItemHasContent } from '../../helper/chat-item';
import { ChatItemTreeFile } from './chat-item-tree-file';
import { fileListToTree } from '../../helper/file-tree';

const TYPEWRITER_STACK_TIME = 500;
export interface ChatItemCardProps {
    tabId: string;
    chatItem: ChatItem;
}
export class ChatItemCard {
    readonly props: ChatItemCardProps;
    render: ExtendedHTMLElement;
    contentBody: CardBody | null = null;
    chatAvatar: ExtendedHTMLElement;
    updateStack: Array<Partial<ChatItem>> = [];
    chatFormItems: ChatItemFormItemsWrapper | null = null;
    customRendererWrapper: CardBody | null = null;
    chatButtons: ChatItemButtonsWrapper | null = null;
    fileTreeWrapper: ChatItemTreeViewWrapper | null = null;
    file: ChatItemTreeFile | null = null;
    typewriterItemIndex: number = 0;
    previousTypewriterItemIndex: number = 0;
    typewriterId: string;
    private updateTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(props: ChatItemCardProps) {
        this.props = props;
        this.chatAvatar = this.getChatAvatar();
        MynahUITabsStore.getInstance()
            .getTabDataStore(this.props.tabId)
            .subscribe('showChatAvatars', (value: boolean) => {
                if (value) {
                    this.chatAvatar = this.getChatAvatar();
                    this.render.insertChild('afterbegin', this.chatAvatar);
                } else {
                    this.chatAvatar.remove();
                }
            });
        this.render = this.generateCard();

        if (this.props.chatItem.type === ChatItemType.ANSWER_STREAM && (this.props.chatItem.body ?? '').trim() !== '') {
            this.updateCardStack({});
        }
    }

    private readonly generateCard = (): ExtendedHTMLElement => {
        const generatedCard = DomBuilder.getInstance().build({
            type: 'div',
            classNames: this.getCardClasses(),
            attributes: {
                messageId: this.props.chatItem.messageId ?? 'unknown',
            },
            children: [
                ...(this.props.chatItem.type === ChatItemType.ANSWER_STREAM && (this.props.chatItem.body ?? '').trim() === ''
                    ? [
                          // Create an empty card with its child set to the loading spinner
                          new Card({
                              children: [
                                  DomBuilder.getInstance().build({
                                      type: 'div',
                                      persistent: true,
                                      classNames: ['mynah-chat-items-spinner'],
                                      children: [{ type: 'span' }, { type: 'div', children: [Config.getInstance().config.texts.spinnerText] }],
                                  }),
                              ],
                          }).render,
                      ]
                    : [...this.getCardContent()]),
            ],
        });

        setTimeout(
            () => {
                generatedCard.addClass('reveal');
                this.checkCardSnap();
            },
            this.props.chatItem.type === ChatItemType.PROMPT ? 10 : 200
        );

        return generatedCard;
    };

    private readonly getCardClasses = (): string[] => {
        const isNoContent =
            !chatItemHasContent(this.props.chatItem) &&
            this.props.chatItem.followUp == null &&
            this.props.chatItem.relatedContent == null &&
            this.props.chatItem.type === ChatItemType.ANSWER;
        return [
            ...(this.props.chatItem.icon !== undefined ? ['mynah-chat-item-card-has-icon'] : []),
            `mynah-chat-item-card-status-${this.props.chatItem.status ?? 'default'}`,
            'mynah-chat-item-card',
            `mynah-chat-item-${this.props.chatItem.type ?? ChatItemType.ANSWER}`,
            ...(!chatItemHasContent(this.props.chatItem) ? ['mynah-chat-item-empty'] : []),
            ...(isNoContent ? ['mynah-chat-item-no-content'] : []),
        ];
    };

    private readonly getCardContent = (): Array<ExtendedHTMLElement | HTMLElement | string | DomBuilderObject> => {
        if (MynahUITabsStore.getInstance().getTabDataStore(this.props.tabId) === undefined) {
            return [];
        }

        const bodyEvents: Partial<CardBodyProps> = {
            onLinkClick: (url: string, e: MouseEvent) => {
                MynahUIGlobalEvents.getInstance().dispatch(MynahEventNames.LINK_CLICK, {
                    messageId: this.props.chatItem.messageId,
                    link: url,
                    event: e,
                });
            },
            ...(Config.getInstance().config.codeCopyToClipboardEnabled !== false && this.props.chatItem.codeCopyToClipboardEnabled !== false
                ? {
                      onCopiedToClipboard: (type, text, referenceTrackerInformation, codeBlockIndex) => {
                          MynahUIGlobalEvents.getInstance().dispatch(MynahEventNames.COPY_CODE_TO_CLIPBOARD, {
                              messageId: this.props.chatItem.messageId,
                              type,
                              text,
                              referenceTrackerInformation,
                              codeBlockIndex,
                              totalCodeBlocks: (this.contentBody?.nextCodeBlockIndex ?? 0) + (this.customRendererWrapper?.nextCodeBlockIndex ?? 0),
                          });
                      },
                  }
                : {}),
            ...(Config.getInstance().config.codeInsertToCursorEnabled !== false && this.props.chatItem.codeInsertToCursorEnabled !== false
                ? {
                      onInsertToCursorPosition: (type, text, referenceTrackerInformation, codeBlockIndex) => {
                          MynahUIGlobalEvents.getInstance().dispatch(MynahEventNames.INSERT_CODE_TO_CURSOR_POSITION, {
                              messageId: this.props.chatItem.messageId,
                              type,
                              text,
                              referenceTrackerInformation,
                              codeBlockIndex,
                              totalCodeBlocks: (this.contentBody?.nextCodeBlockIndex ?? 0) + (this.customRendererWrapper?.nextCodeBlockIndex ?? 0),
                          });
                      },
                  }
                : {}),
        };

        /**
         * Generate contentBody if available
         */
        if (this.contentBody !== null) {
            this.contentBody.render.remove();
            this.contentBody = null;
        }
        if (this.props.chatItem.body !== undefined) {
            this.contentBody = new CardBody({
                body: this.props.chatItem.body ?? '',
                useParts: this.props.chatItem.type === ChatItemType.ANSWER_STREAM,
                highlightRangeWithTooltip: this.props.chatItem.codeReference,
                children:
                    this.props.chatItem.relatedContent !== undefined
                        ? [
                              new ChatItemSourceLinksContainer({
                                  messageId: this.props.chatItem.messageId ?? 'unknown',
                                  tabId: this.props.tabId,
                                  relatedContent: this.props.chatItem.relatedContent?.content,
                                  title: this.props.chatItem.relatedContent?.title,
                              }).render,
                          ]
                        : [],
                ...bodyEvents,
            });
        }

        /**
         * Generate customRenderer if available
         */
        if (this.customRendererWrapper !== null) {
            this.customRendererWrapper.render.remove();
            this.customRendererWrapper = null;
        }
        if (this.props.chatItem.customRenderer !== undefined) {
            const customRendererContent: Partial<DomBuilderObject> = {};

            if (typeof this.props.chatItem.customRenderer === 'object') {
                customRendererContent.children = Array.isArray(this.props.chatItem.customRenderer)
                    ? this.props.chatItem.customRenderer
                    : [this.props.chatItem.customRenderer];
            } else if (typeof this.props.chatItem.customRenderer === 'string') {
                customRendererContent.innerHTML = cleanHtml(this.props.chatItem.customRenderer);
            }

            this.customRendererWrapper = new CardBody({
                body: customRendererContent.innerHTML,
                children: customRendererContent.children,
                processChildren: true,
                useParts: true,
                codeBlockStartIndex: this.contentBody?.nextCodeBlockIndex ?? 0,
                ...bodyEvents,
            });
        }

        /**
         * Generate form items if available
         */
        if (this.chatFormItems !== null) {
            this.chatFormItems.render.remove();
            this.chatFormItems = null;
        }
        if (this.props.chatItem.formItems !== undefined) {
            this.chatFormItems = new ChatItemFormItemsWrapper({ tabId: this.props.tabId, chatItem: this.props.chatItem });
        }

        /**
         * Generate buttons if available
         */
        if (this.chatButtons !== null) {
            this.chatButtons.render.remove();
            this.chatButtons = null;
        }
        if (this.props.chatItem.buttons !== undefined) {
            this.chatButtons = new ChatItemButtonsWrapper({
                tabId: this.props.tabId,
                formItems: this.chatFormItems,
                buttons: this.props.chatItem.buttons,
                onActionClick: action => {
                    MynahUIGlobalEvents.getInstance().dispatch(MynahEventNames.BODY_ACTION_CLICKED, {
                        tabId: this.props.tabId,
                        messageId: this.props.chatItem.messageId,
                        actionId: action.id,
                        actionText: action.text,
                        ...(this.chatFormItems !== null ? { formItemValues: this.chatFormItems.getAllValues() } : {}),
                    });

                    if (action.keepCardAfterClick === false) {
                        this.render.remove();
                        if (this.props.chatItem.messageId !== undefined) {
                            const currentChatItems: ChatItem[] = MynahUITabsStore.getInstance().getTabDataStore(this.props.tabId).getValue('chatItems');
                            MynahUITabsStore.getInstance()
                                .getTabDataStore(this.props.tabId)
                                .updateStore(
                                    {
                                        chatItems: [
                                            ...currentChatItems.map(chatItem =>
                                                this.props.chatItem.messageId !== chatItem.messageId
                                                    ? chatItem
                                                    : { type: ChatItemType.ANSWER, messageId: chatItem.messageId }
                                            ),
                                        ],
                                    },
                                    true
                                );
                        }
                    }
                },
            });
        }

        /**
         * Generate file tree if available
         */
        if (this.fileTreeWrapper !== null) {
            this.fileTreeWrapper.render.remove();
            this.fileTreeWrapper = null;
            this.file = null;
        }
        if (this.props.chatItem.fileList !== undefined) {
            const { filePaths = [], deletedFiles = [], actions, details } = this.props.chatItem.fileList;
            const referenceSuggestionLabel = this.props.chatItem.body ?? '';
            if (filePaths.length > 1) {
                this.fileTreeWrapper = new ChatItemTreeViewWrapper({
                    tabId: this.props.tabId,
                    messageId: this.props.chatItem.messageId ?? '',
                    cardTitle: this.props.chatItem.fileList.fileTreeTitle,
                    rootTitle: this.props.chatItem.fileList.rootFolderTitle,
                    files: filePaths,
                    deletedFiles,
                    actions,
                    details,
                    references: this.props.chatItem.codeReference ?? [],
                    referenceSuggestionLabel,
                });
            } else {
                const filePath = filePaths[0];
                const fileName = filePath.split('/').pop() ?? filePath;

                this.file = new ChatItemTreeFile({
                    tabId: this.props.tabId,
                    messageId: this.props.chatItem.messageId ?? '',
                    filePath,
                    fileName,
                    actions: undefined,
                    details: undefined,
                    deleted: false,
                    icon: MynahIcons.PAPER_CLIP,
                });
            }
        }

        return [
            ...(MynahUITabsStore.getInstance().getTabDataStore(this.props.tabId).getValue('showChatAvatars') === true ? [this.chatAvatar] : []),

            ...(chatItemHasContent(this.props.chatItem)
                ? [
                      new Card({
                          onCardEngaged: engagement => {
                              MynahUIGlobalEvents.getInstance().dispatch(MynahEventNames.CHAT_ITEM_ENGAGEMENT, {
                                  engagement,
                                  messageId: this.props.chatItem.messageId,
                              });
                          },
                          children: [
                              ...(this.props.chatItem.icon !== undefined
                                  ? [new Icon({ icon: this.props.chatItem.icon, classNames: ['mynah-chat-item-card-icon'] }).render]
                                  : []),
                              ...(this.contentBody !== null ? [this.contentBody.render] : []),
                              ...(this.customRendererWrapper !== null ? [this.customRendererWrapper.render] : []),
                              ...(this.chatFormItems !== null ? [this.chatFormItems.render] : []),
                              ...(this.fileTreeWrapper !== null ? [this.fileTreeWrapper.render] : []),
                              ...(this.file !== null ? [this.file.render] : []),
                              ...(this.chatButtons !== null ? [this.chatButtons.render] : []),
                              ...(this.props.chatItem.canBeVoted === true && this.props.chatItem.messageId !== undefined
                                  ? [new ChatItemRelevanceVote({ tabId: this.props.tabId, messageId: this.props.chatItem.messageId }).render]
                                  : []),
                          ],
                      }).render,
                  ]
                : ''),
            this.props.chatItem.followUp?.text !== undefined
                ? new ChatItemFollowUpContainer({ tabId: this.props.tabId, chatItem: this.props.chatItem }).render
                : '',
        ];
    };

    private readonly getChatAvatar = (): ExtendedHTMLElement =>
        DomBuilder.getInstance().build({
            type: 'div',
            classNames: ['mynah-chat-item-card-icon-wrapper'],
            children: [new Icon({ icon: this.props.chatItem.type === ChatItemType.PROMPT ? MynahIcons.USER : MynahIcons.MYNAH }).render],
        });

    private readonly getInsertedTypewriterPartsCss = (): ExtendedHTMLElement =>
        DomBuilder.getInstance().build({
            type: 'style',
            attributes: {
                type: 'text/css',
            },
            persistent: true,
            innerHTML: `
    ${new Array(Math.max(0, (this.typewriterItemIndex ?? 0) - (this.previousTypewriterItemIndex ?? 0)))
        .fill(null)
        .map((n, i) => {
            return `
        .${this.typewriterId} .typewriter-part[index="${i + this.previousTypewriterItemIndex}"] {
          animation: none !important;
          opacity: 1 !important;
          visibility: visible !important;
        }

        `;
        })
        .join('')}
    `,
        });

    private readonly getInsertingTypewriterPartsCss = (newWordsCount: number, timeForEach: number): ExtendedHTMLElement =>
        DomBuilder.getInstance().build({
            type: 'style',
            attributes: {
                type: 'text/css',
            },
            innerHTML: `
        ${new Array(Math.max(0, newWordsCount ?? 0))
            .fill(null)
            .map((n, i) => {
                return `
            .${this.typewriterId} .typewriter-part[index="${i + this.typewriterItemIndex}"] {
              animation: typewriter 100ms ease-out forwards;
              animation-delay: ${i * timeForEach}ms !important;
            }
            `;
            })
            .join('')}
        `,
        });

    private readonly checkCardSnap = (): void => {
        // If the chat item has snapToTop value as true, we'll snap the card to the container top
        if (this.render.offsetParent != null && this.props.chatItem.snapToTop === true) {
            this.render.offsetParent.scrollTop = this.render.offsetTop - CONTAINER_GAP - (this.render.offsetParent as HTMLElement).offsetTop;
        }
    };

    public readonly updateCard = (): void => {
        this.checkCardSnap();
        if (this.updateTimer === undefined && this.updateStack.length > 0) {
            const updateWith: Partial<ChatItem> | undefined = this.updateStack.shift();
            if (updateWith !== undefined) {
                this.props.chatItem = {
                    ...this.props.chatItem,
                    ...updateWith,
                };

                // Update item inside the store
                if (this.props.chatItem.messageId !== undefined) {
                    const currentTabChatItems = MynahUITabsStore.getInstance().getTabDataStore(this.props.tabId)?.getStore()?.chatItems;
                    MynahUITabsStore.getInstance()
                        .getTabDataStore(this.props.tabId)
                        .updateStore(
                            {
                                chatItems: currentTabChatItems?.map((chatItem: ChatItem) => {
                                    if (chatItem.messageId === this.props.chatItem.messageId) {
                                        return this.props.chatItem;
                                    }
                                    return chatItem;
                                }),
                            },
                            true
                        );
                }

                const newCardContent = this.getCardContent();
                const upcomingWords = Array.from(this.contentBody?.render.querySelectorAll('.typewriter-part') ?? []);
                for (let i = 0; i < upcomingWords.length; i++) {
                    upcomingWords[i].setAttribute('index', i.toString());
                }
                if (this.typewriterId === undefined) {
                    this.typewriterId = `typewriter-card-${generateUID()}`;
                }
                this.render?.update({
                    ...(this.props.chatItem.messageId != null
                        ? {
                              attributes: {
                                  messageid: this.props.chatItem.messageId,
                              },
                          }
                        : {}),
                    classNames: [...this.getCardClasses(), 'reveal', this.typewriterId, 'typewriter-animating'],
                    children: [...newCardContent, this.getInsertedTypewriterPartsCss()],
                });

                // How many new words will be added
                const newWordsCount = upcomingWords.length - this.typewriterItemIndex;

                // For each stack, without exceeding 500ms in total
                // we're setting each words delay time according to the count of them.
                // Word appearance time cannot exceed 50ms
                // Stack's total appearance time cannot exceed 500ms
                const timeForEach = Math.min(50, Math.floor(TYPEWRITER_STACK_TIME / newWordsCount));

                // Generate animator style and inject into render
                // CSS animations ~100 times faster then js timeouts/intervals
                this.render.insertChild('beforeend', this.getInsertingTypewriterPartsCss(newWordsCount, timeForEach));

                // All the animator selectors injected
                // update the words count for a potential upcoming set
                this.previousTypewriterItemIndex = this.typewriterItemIndex;
                this.typewriterItemIndex = upcomingWords.length;

                // If there is another set
                // call the same function to check after current stack totally shown
                this.updateTimer = setTimeout(() => {
                    this.render.removeClass('typewriter-animating');
                    this.render.insertChild('beforeend', this.getInsertedTypewriterPartsCss());
                    this.updateTimer = undefined;
                    this.updateCard();
                }, timeForEach * newWordsCount);
            }
        }
    };

    public readonly updateCardStack = (updateWith: Partial<ChatItem>): void => {
        this.updateStack.push(updateWith);
        this.updateCard();
    };

    public readonly getRenderDetails = (): CardRenderDetails => {
        return {
            totalNumberOfCodeBlocks: (this.contentBody?.nextCodeBlockIndex ?? 0) + (this.customRendererWrapper?.nextCodeBlockIndex ?? 0),
        };
    };
}
