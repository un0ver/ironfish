/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use wasm_bindgen::prelude::*;

use ironfish_rust::sapling_bls12::{
    Key, ProposedTransaction, PublicAddress, SimpleTransaction, Transaction, SAPLING,
};

use super::note::WasmNote;
use super::spend_proof::WasmSpendProof;
use super::witness::JsWitness;

#[wasm_bindgen]
pub struct WasmTransactionPosted {
    transaction: Transaction,
}

#[wasm_bindgen]
impl WasmTransactionPosted {
    #[wasm_bindgen]
    pub fn deserialize(bytes: &[u8]) -> WasmTransactionPosted {
        console_error_panic_hook::set_once();
        let mut cursor: std::io::Cursor<&[u8]> = std::io::Cursor::new(bytes);
        let transaction = Transaction::read(SAPLING.clone(), &mut cursor).unwrap();
        WasmTransactionPosted { transaction }
    }

    #[wasm_bindgen]
    pub fn serialize(&self) -> Vec<u8> {
        let mut cursor: std::io::Cursor<Vec<u8>> = std::io::Cursor::new(vec![]);
        self.transaction.write(&mut cursor).unwrap();
        cursor.into_inner()
    }

    #[wasm_bindgen]
    pub fn verify(&self) -> bool {
        match self.transaction.verify() {
            Ok(_) => true,
            Err(_e) => false,
        }
    }

    #[wasm_bindgen(getter, js_name = "notesLength")]
    pub fn notes_length(&self) -> usize {
        self.transaction.receipts().len()
    }

    #[wasm_bindgen(js_name = "getNote")]
    pub fn get_note(&self, index: usize) -> Vec<u8> {
        let proof = &self.transaction.receipts()[index];
        // Note bytes are 275
        let mut cursor: Vec<u8> = Vec::with_capacity(275);
        proof.merkle_note().write(&mut cursor).unwrap();
        cursor
    }

    #[wasm_bindgen(getter, js_name = "spendsLength")]
    pub fn spends_length(&self) -> usize {
        self.transaction.spends().len()
    }

    #[wasm_bindgen(js_name = "getSpend")]
    pub fn get_spend(&self, index: usize) -> WasmSpendProof {
        let proof = &self.transaction.spends()[index];
        WasmSpendProof {
            proof: proof.clone(),
        }
    }

    #[wasm_bindgen(getter, js_name = "transactionFee")]
    pub fn transaction_fee(&self) -> i64 {
        self.transaction.transaction_fee()
    }

    #[wasm_bindgen(getter, js_name = "transactionSignature")]
    pub fn transaction_signature(&self) -> Vec<u8> {
        let mut serialized_signature = vec![];
        self.transaction
            .binding_signature()
            .write(&mut serialized_signature)
            .unwrap();
        serialized_signature
    }

    #[wasm_bindgen(getter, js_name = "transactionHash")]
    pub fn transaction_hash(&self) -> Vec<u8> {
        self.transaction.transaction_signature_hash().to_vec()
    }
}

#[wasm_bindgen]
pub struct WasmTransaction {
    transaction: ProposedTransaction,
}

#[wasm_bindgen]
impl WasmTransaction {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmTransaction {
        console_error_panic_hook::set_once();
        WasmTransaction {
            transaction: ProposedTransaction::new(SAPLING.clone()),
        }
    }

    /// Create a proof of a new note owned by the recipient in this transaction.
    #[wasm_bindgen]
    pub fn receive(&mut self, spender_hex_key: &str, note: &WasmNote) -> String {
        let spender_key = Key::from_hex(SAPLING.clone(), spender_hex_key).unwrap();
        match self.transaction.receive(&spender_key, &note.note) {
            Ok(_) => "".into(),
            Err(e) => match e {
                ironfish_rust::errors::SaplingProofError::InconsistentWitness => {
                    "InconsistentWitness".into()
                }
                ironfish_rust::errors::SaplingProofError::IOError => "IOError".into(),
                ironfish_rust::errors::SaplingProofError::ReceiptCircuitProofError => {
                    "ReceiptCircuitProofError".into()
                }
                ironfish_rust::errors::SaplingProofError::SaplingKeyError => {
                    "SaplingKeyError".into()
                }
                ironfish_rust::errors::SaplingProofError::SigningError => "SigningError".into(),
                ironfish_rust::errors::SaplingProofError::SpendCircuitProofError(d) => {
                    format!("SpendCircuitProofError - {}", d)
                }
                ironfish_rust::errors::SaplingProofError::VerificationFailed => {
                    "VerificationFailed".into()
                }
            },
        }
    }

    /// Spend the note owned by spender_hex_key at the given witness location.
    #[wasm_bindgen]
    pub fn spend(&mut self, spender_hex_key: &str, note: &WasmNote, witness: &JsWitness) -> String {
        let spender_key = Key::from_hex(SAPLING.clone(), spender_hex_key).unwrap();
        match self.transaction.spend(spender_key, &note.note, witness) {
            Ok(_) => "".into(),
            Err(e) => match e {
                ironfish_rust::errors::SaplingProofError::InconsistentWitness => {
                    "InconsistentWitness".into()
                }
                ironfish_rust::errors::SaplingProofError::IOError => "IOError".into(),
                ironfish_rust::errors::SaplingProofError::ReceiptCircuitProofError => {
                    "ReceiptCircuitProofError".into()
                }
                ironfish_rust::errors::SaplingProofError::SaplingKeyError => {
                    "SaplingKeyError".into()
                }

                ironfish_rust::errors::SaplingProofError::SigningError => "SigningError".into(),
                ironfish_rust::errors::SaplingProofError::SpendCircuitProofError(d) => {
                    format!("SpendCircuitProofError - {}", d)
                }
                ironfish_rust::errors::SaplingProofError::VerificationFailed => {
                    "VerificationFailed".into()
                }
            },
        }
    }

    /// Special case for posting a miners fee transaction. Miner fee transactions
    /// are unique in that they generate currency. They do not have any spends
    /// or change and therefore have a negative transaction fee. In normal use,
    /// a miner would not accept such a transaction unless it was explicitly set
    /// as the miners fee.
    #[wasm_bindgen]
    pub fn post_miners_fee(&mut self) -> WasmTransactionPosted {
        WasmTransactionPosted {
            transaction: self.transaction.post_miners_fee().unwrap(),
        }
    }

    /// Post the transaction. This performs a bit of validation, and signs
    /// the spends with a signature that proves the spends are part of this
    /// transaction.
    ///
    /// Transaction fee is the amount the spender wants to send to the miner
    /// for mining this transaction. This has to be non-negative; sane miners
    /// wouldn't accept a transaction that takes money away from them.
    ///
    /// sum(spends) - sum(outputs) - intended_transaction_fee - change = 0
    /// aka: self.transaction_fee - intended_transaction_fee - change = 0
    #[wasm_bindgen]
    pub fn post(
        &mut self,
        spender_hex_key: &str,
        change_goes_to: Option<String>,
        intended_transaction_fee: u64,
    ) -> WasmTransactionPosted {
        let spender_key = Key::from_hex(SAPLING.clone(), spender_hex_key).unwrap();
        let change_key = match change_goes_to {
            Some(s) => Some(PublicAddress::from_hex(SAPLING.clone(), &s).unwrap()),
            None => None,
        };
        WasmTransactionPosted {
            transaction: self
                .transaction
                .post(&spender_key, change_key, intended_transaction_fee)
                .unwrap(),
        }
    }
}

impl Default for WasmTransaction {
    fn default() -> Self {
        WasmTransaction::new()
    }
}

#[wasm_bindgen]
pub struct WasmSimpleTransaction {
    transaction: SimpleTransaction,
}

#[wasm_bindgen]
impl WasmSimpleTransaction {
    #[wasm_bindgen(constructor)]
    pub fn new(spender_hex_key: &str, intended_transaction_fee: u64) -> WasmSimpleTransaction {
        console_error_panic_hook::set_once();
        let spender_key = Key::from_hex(SAPLING.clone(), spender_hex_key).unwrap();
        WasmSimpleTransaction {
            transaction: SimpleTransaction::new(
                SAPLING.clone(),
                spender_key,
                intended_transaction_fee,
            ),
        }
    }

    #[wasm_bindgen]
    pub fn spend(&mut self, note: &WasmNote, witness: &JsWitness) -> String {
        match self.transaction.spend(&note.note, witness) {
            Ok(_) => "".into(),
            Err(e) => match e {
                ironfish_rust::errors::SaplingProofError::InconsistentWitness => {
                    "InconsistentWitness".into()
                }
                ironfish_rust::errors::SaplingProofError::IOError => "IOError".into(),
                ironfish_rust::errors::SaplingProofError::ReceiptCircuitProofError => {
                    "ReceiptCircuitProofError".into()
                }
                ironfish_rust::errors::SaplingProofError::SaplingKeyError => {
                    "SaplingKeyError".into()
                }

                ironfish_rust::errors::SaplingProofError::SigningError => "SigningError".into(),
                ironfish_rust::errors::SaplingProofError::SpendCircuitProofError(d) => {
                    format!("SpendCircuitProofError - {}", d)
                }
                ironfish_rust::errors::SaplingProofError::VerificationFailed => {
                    "VerificationFailed".into()
                }
            },
        }
    }

    #[wasm_bindgen]
    pub fn receive(&mut self, note: &WasmNote) -> String {
        match self.transaction.receive(&note.note) {
            Ok(_) => "".into(),
            Err(e) => match e {
                ironfish_rust::errors::SaplingProofError::InconsistentWitness => {
                    "InconsistentWitness".into()
                }
                ironfish_rust::errors::SaplingProofError::IOError => "IOError".into(),
                ironfish_rust::errors::SaplingProofError::ReceiptCircuitProofError => {
                    "ReceiptCircuitProofError".into()
                }
                ironfish_rust::errors::SaplingProofError::SaplingKeyError => {
                    "SaplingKeyError".into()
                }
                ironfish_rust::errors::SaplingProofError::SigningError => "SigningError".into(),
                ironfish_rust::errors::SaplingProofError::SpendCircuitProofError(d) => {
                    format!("SpendCircuitProofError - {}", d)
                }
                ironfish_rust::errors::SaplingProofError::VerificationFailed => {
                    "VerificationFailed".into()
                }
            },
        }
    }

    #[wasm_bindgen]
    pub fn post(&mut self) -> WasmTransactionPosted {
        WasmTransactionPosted {
            transaction: self.transaction.post().unwrap(),
        }
    }
}
