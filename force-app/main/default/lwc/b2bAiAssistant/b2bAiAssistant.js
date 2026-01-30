import { LightningElement, track, api } from 'lwc';
import askEinstein from '@salesforce/apex/B2BCommerceOrderMatrixController.askEinstein';

export default class B2bAiAssistant extends LightningElement {
    
    @api products = [];

    @track messages = [
        { 
            id: 'welcome', 
            text: "Hello! I'm your B2B Sales Assistant. How can I help you today?", 
            isAi: true,
            wrapperClass: 'message-wrapper left', 
            bubbleClass: 'chat-bubble left' 
        }
    ];
    @track userInput = '';
    @track isTyping = false;
    
    conversationContext = ''; 

    handleInputChange(event) { this.userInput = event.target.value; }
    handleKeyUp(event) { if (event.key === 'Enter') this.handleSend(); }

    // --- NOUVELLE LOGIQUE IA-DRIVEN (System Prompt) ---
    @api async triggerAiRecommendation(addedItemName, recommendedItems) {
        this.isTyping = true; // Montre que l'IA réfléchit

        // Construction du message système invisible
        // On donne à l'IA ce que l'utilisateur a fait + les produits à recommander
        const systemPrompt = `SYSTEM_CONTEXT: The user successfully added "${addedItemName}" to their cart. 
        Based on this, the system recommends these specific Cross-Sell products: 
        ${JSON.stringify(recommendedItems)}. 
        INSTRUCTION: Inform the user that the item was added, then suggest these recommendations naturally using the provided data.`;

        // On passe le catalogue complet (this.products) comme contexte global
        // mais le systemPrompt donne le focus immédiat.
        const contextString = JSON.stringify(this.products); 

        try {
            const result = await askEinstein({ 
                userMessage: systemPrompt, // L'IA reçoit ça comme une instruction interne
                productContextString: contextString
            });

            this.isTyping = false;

            if (result.success) {
                const aiData = JSON.parse(result.response);
                
                // L'IA a généré le texte ET les items à afficher
                let cardsToDisplay = [];
                if (aiData.items) {
                    cardsToDisplay = aiData.items.map(item => {
                        // On retrouve les détails complets (Image, etc) 
                        const fullData = recommendedItems.find(r => r.sku === item.sku) || 
                                         this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
                        
                        if (fullData) {
                            return {
                                id: fullData.id,
                                name: fullData.name,
                                sku: fullData.sku || fullData.StockKeepingUnit,
                                price: fullData.displayUnitPrice || fullData.unitPrice,
                                imgUrl: fullData.imgUrl,
                                promo: fullData.promoName || fullData.promo,
                                currency: 'USD'
                            };
                        }
                        return null;
                    }).filter(x => x !== null);
                }

                // Ajout du message IA
                this.messages = [...this.messages, {
                    id: Date.now(),
                    text: aiData.message, // Le texte généré par l'IA
                    isAi: true,
                    products: cardsToDisplay.length > 0 ? cardsToDisplay : null,
                    wrapperClass: 'message-wrapper left',
                    bubbleClass: 'chat-bubble left'
                }];
                
                this.conversationContext += `\nAssistant: ${aiData.message}`;
                this.scrollToBottom();
            }
        } catch (e) {
            this.isTyping = false;
            console.error('AI Trigger Error', e);
        }
    }

    async handleSend() {
        if (!this.userInput.trim()) return;

        const text = this.userInput;
        this.addMessage(text, false);
        this.conversationContext += `\nUser: ${text}`;
        
        this.userInput = '';
        this.isTyping = true;
        this.scrollToBottom();

        const contextData = this.products.map(p => {
            let tierInfo = '';
            if (p.tierList && p.tierList.length > 0) {
                tierInfo = p.tierList.map(t => t.label).join(', ');
            }
            
            const sellingPrice = p.displayUnitPrice || p.unitPrice; 
            let standardPrice = p.displayListPrice;
            if (!standardPrice && sellingPrice !== p.unitPrice) {
                standardPrice = p.unitPrice;
            }

            let stockVal = 'Unlimited';
            if (p.stock !== undefined && p.stock !== null && p.stock !== '') {
                 stockVal = p.stock;
            }

            let enrichedDesc = p.Description || '';
            if (p.variationInfo) {
                enrichedDesc += ` (${p.variationInfo})`;
            }

            return {
                name: p.name,
                sku: p.sku || p.StockKeepingUnit, 
                desc: enrichedDesc, 
                price: sellingPrice,       
                listPrice: standardPrice,  
                promo: p.promoName || '',  
                stock: stockVal,             
                selected: p.qtyValue || 0,   
                inCart: p.cartQty || 0,      
                min: p.minQty || 1,
                max: p.maxQty || '',
                inc: p.increment || 1,
                tiers: tierInfo
            };
        });

        const contextString = JSON.stringify(contextData); 

        try {
            const result = await askEinstein({ 
                userMessage: this.conversationContext,
                productContextString: contextString
            });
            
            this.isTyping = false;

            if (result.success) {
                try {
                    const aiData = JSON.parse(result.response);
                    this.conversationContext += `\nAssistant: ${aiData.message}`;

                    let productsToDisplay = [];
                    
                    if (aiData.items && Array.isArray(aiData.items)) {
                        aiData.items.forEach(item => {
                            const foundProduct = this.products.find(p => 
                                (p.sku === item.sku) || (p.StockKeepingUnit === item.sku)
                            );

                            if (foundProduct) {
                                let finalQty = 0;
                                let qtyRaw = item.quantity ? parseInt(item.quantity, 10) : 0;

                                console.log(`🤖 Action IA pour ${item.sku}: ${item.action} (Qté: ${qtyRaw})`);

                                if (item.action === 'set') {
                                    const currentSelected = foundProduct.qtyValue ? parseFloat(foundProduct.qtyValue) : 0;
                                    finalQty = qtyRaw - currentSelected;
                                } 
                                else if (item.action === 'remove') {
                                    finalQty = -qtyRaw;
                                }
                                else {
                                    finalQty = qtyRaw;
                                }

                                if (finalQty !== 0 && item.action !== 'search') {
                                    this.dispatchEvent(new CustomEvent('addproduct', {
                                        detail: { 
                                            sku: foundProduct.sku || foundProduct.StockKeepingUnit, 
                                            quantity: finalQty 
                                        }
                                    }));
                                }
                                productsToDisplay.push(foundProduct);
                            }
                        });
                    }
                    this.addMessage(aiData.message, true, productsToDisplay);

                } catch (jsonError) {
                    console.error('JSON Parse Error:', jsonError);
                    this.addMessage(result.response, true);
                    this.conversationContext += `\nAssistant: ${result.response}`;
                }

            } else {
                this.addMessage("⚠️ " + result.message, true);
            }

        } catch (error) {
            this.isTyping = false;
            console.error('LWC Error:', error);
            this.addMessage("Sorry, connection error.", true);
        }

        this.scrollToBottom();
    }

    addMessage(text, isAi, products = null) {
        let productCards = [];
        
        if (products) {
            const list = Array.isArray(products) ? products : [products];
            
            productCards = list.map(p => {
                const sellingPrice = p.displayUnitPrice || p.unitPrice;
                let standardPrice = p.displayListPrice;
                if (!standardPrice && sellingPrice !== p.unitPrice) {
                    standardPrice = p.unitPrice;
                }

                let specsArray = [];
                if (p.variationInfo) {
                    specsArray = p.variationInfo.split(', '); 
                }

                return {
                    id: p.id,
                    name: p.name,
                    sku: p.sku || p.StockKeepingUnit,
                    price: sellingPrice,
                    imgUrl: p.imgUrl,
                    promo: p.promoName,
                    listPrice: standardPrice, 
                    currency: p.currencyCode || 'USD',
                    specs: specsArray 
                };
            });
        }

        this.messages = [...this.messages, {
            id: Date.now(),
            text: text,
            isAi: isAi,
            products: productCards.length > 0 ? productCards : null,
            wrapperClass: `message-wrapper ${isAi ? 'left' : 'right'}`,
            bubbleClass: `chat-bubble ${isAi ? 'left' : 'right'}`
        }];
    }

    scrollToBottom() {
        setTimeout(() => {
            const chatBox = this.template.querySelector('.chat-messages');
            if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
        }, 50);
    }

    handleAddRequest(event) {
        const sku = event.target.dataset.sku;
        const qty = parseInt(event.target.dataset.qty, 10);
        this.dispatchEvent(new CustomEvent('addproduct', {
            detail: { sku: sku, quantity: qty }
        }));
    }
}