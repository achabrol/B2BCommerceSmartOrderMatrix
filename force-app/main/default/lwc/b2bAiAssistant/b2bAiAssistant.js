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

            // Description enrichie pour l'IA
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
                                    // --- CORRECTION ICI ---
                                    // Le produit brut (foundProduct) a sa quantité dans 'qtyValue', pas 'selected'.
                                    // 'selected' n'existe que dans le JSON envoyé à l'IA, pas dans l'objet source.
                                    const currentSelected = foundProduct.qtyValue ? parseFloat(foundProduct.qtyValue) : 0;
                                    
                                    // Calcul du Delta : Cible - Actuel
                                    finalQty = qtyRaw - currentSelected;
                                    
                                    console.log(`   -> Mode SET: Actuel=${currentSelected}, Cible=${qtyRaw} => Delta=${finalQty}`);
                                } 
                                else if (item.action === 'remove') {
                                    finalQty = -qtyRaw;
                                }
                                else {
                                    // Default add/search
                                    finalQty = qtyRaw;
                                }

                                if (finalQty !== 0) {
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

                // Transformation de "Color: Blue, Size: M" en tableau ["Color: Blue", "Size: M"]
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