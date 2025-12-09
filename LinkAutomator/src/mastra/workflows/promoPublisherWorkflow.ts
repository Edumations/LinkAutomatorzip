import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- DICIONÁRIO DE BUSCA EM CASCATA ---
// Estrutura: { termo_principal: [tentativa1, tentativa2, tentativa3] }
const SEARCH_GROUPS = [
    ["EcoLife Perfume Floral", "UrbanPro Chaleira Elétrica", "Nordic Blusa Feminina", "Nordic Toalha de Banho", "Nordic Óculos de Sol", "UrbanPro Tripé Fotográfico", "UrbanPro Notebook Slim", "PetJoy Caixa de Som", "StudioMax Ração Premium", "BioZen Livro Ilustrado", "TechWay Geladeira FrostFree", "EcoLife Geladeira FrostFree", "StudioMax Tripé Fotográfico", "PrimeFlex Guarda-Roupas", "AeroFit Perfume Floral", "PrimeFlex Jogo de Estratégia", "TechWay Bicicleta Dobrável", "Nordic Vestido Social", "AeroFit Blusa Feminina", "EcoLife Guia Retrátil", "Nordic Tinta Acrílica", "PrimeFlex Blender Gourmet", "StudioMax Fogão Inox", "Nordic Jogo de Estratégia", "BioZen Blusa Feminina", "UrbanPro Fone Bluetooth", "Nordic Cadeira de Escritório", "UrbanPro Vacina Pet", "Nordic Notebook Slim", "UrbanPro Perfume Floral", "PrimeFlex Geladeira FrostFree", "EcoLife Ração Premium", "TechWay Jogo Educativo", "EcoLife Luminária Decorativa", "EcoLife Vacina Pet", "PetJoy Vestido Social", "BioZen Monitor HD", "EcoLife Fone Bluetooth", "Lumina Notebook Slim", "PrimeFlex Cadeira de Escritório", "Lumina Câmera Digital", "StudioMax Toalha de Banho", "BioZen Sandália Casual", "EcoLife Monitor Cardíaco", "AeroFit Monitor Cardíaco", "PetJoy Ventilador Turbo", "UrbanPro Bicicleta Dobrável", "TechWay Kit Médicos", "Lumina Geladeira FrostFree", "PetJoy Sandália Casual", "StudioMax Blusa Feminina", "AeroFit Tripé Fotográfico", "AeroFit Kit Escolar", "EcoLife Caixa Organizadora", "BioZen Cortina Blackout", "Nordic Bicicleta Dobrável", "UrbanPro Fogão Inox", "StudioMax Violão Acústico", "Nordic Caixa de Som", "Lumina Whey Protein", "AeroFit Cortina Blackout", "PetJoy Ventilador Turbo", "BioZen Ventilador Turbo", "AeroFit Luminária Decorativa", "UrbanPro Caixa de Som", "BioZen Geladeira FrostFree", "UrbanPro Cortina Blackout", "AeroFit Bicicleta Dobrável", "Lumina Vestido Social", "EcoLife Guia Retrátil", "TechWay Cadeira de Escritório", "PrimeFlex Guarda-Roupas", "TechWay Carrinho de Bebê", "Nordic Tripé Fotográfico", "BioZen Protetor Solar Facial", "PrimeFlex Teclado Mecânico", "StudioMax Carrinho de Bebê", "BioZen Teclado Mecânico", "AeroFit Blender Gourmet", "UrbanPro Vacina Pet", "PrimeFlex Massageador Portátil", "TechWay Monitor Cardíaco", "PrimeFlex Kit Escolar", "Lumina Guia Retrátil", "UrbanPro Óculos de Sol", "Nordic Ração Premium", "StudioMax Toalha de Banho", "EcoLife Drone Compacto", "EcoLife Drone Compacto", "EcoLife Carrinho de Bebê", "Lumina Fogão Inox", "UrbanPro Whey Protein", "Nordic Roteador Wi-Fi", "PrimeFlex Cortina Blackout", "BioZen Caixa Organizadora", "BioZen Blusa Feminina", "UrbanPro Drone Compacto", "AeroFit Perfume Floral", "UrbanPro Shampoo Hidratante", "StudioMax Ração Premium", "PetJoy Moletom Unissex", "Lumina Tripé Fotográfico", "AeroFit Guarda-Roupas", "UrbanPro Drone Compacto", "PetJoy Luminária Decorativa", "Lumina Roteador Wi-Fi", "EcoLife Roteador Wi-Fi", "PrimeFlex Console Portátil", "BioZen Óculos de Sol", "PrimeFlex Caixa Organizadora", "Lumina Console Portátil", "Nordic Teclado Mecânico", "BioZen Drone Compacto", "UrbanPro Teclado Mecânico", "TechWay Fone Bluetooth", "EcoLife Moletom Unissex", "Nordic Câmera Digital", "Nordic Mouse Gamer", "PetJoy Pincéis Artísticos", "EcoLife Vestido Social", "PrimeFlex Fone Bluetooth", "Lumina Saia Midi", "Lumina Shampoo Hidratante", "StudioMax Perfume Floral", "Nordic Roteador Wi-Fi", "AeroFit Protetor Solar Facial", "PetJoy Fogão Inox", "TechWay Guarda-Roupas", "Nordic Livro Ilustrado", "TechWay Teclado Mecânico", "Lumina Bicicleta Dobrável", "TechWay Livro Ilustrado", "TechWay Notebook Slim", "EcoLife Smartwatch", "AeroFit Caixa Organizadora", "UrbanPro Fogão Inox", "BioZen Blender Gourmet", "Nordic Mouse Gamer", "EcoLife Moletom Unissex", "EcoLife Saia Midi", "AeroFit Moletom Unissex", "Nordic Fone Bluetooth", "Nordic Monitor Cardíaco", "TechWay Drone Compacto", "TechWay Blusa Feminina", "PetJoy Geladeira FrostFree", "PrimeFlex Jogo de Estratégia", "PetJoy Blender Gourmet", "Lumina Perfume Floral", "BioZen Cadeira de Escritório", "StudioMax Cadeira de Escritório", "AeroFit Drone Compacto", "AeroFit Jogo de Estratégia", "StudioMax Bicicleta Dobrável", "PrimeFlex Tripé Fotográfico", "PetJoy Monitor HD", "TechWay Kit Escolar", "UrbanPro Jogo Educativo", "StudioMax Ventilador Turbo", "UrbanPro Caixa Organizadora", "TechWay Pincéis Artísticos", "Lumina Monitor HD", "StudioMax Mouse Gamer", "PrimeFlex Caixa de Som", "Lumina Cadeira de Escritório", "PetJoy Kit Escolar", "Nordic Massageador Portátil", "PetJoy Bicicleta Dobrável", "AeroFit Massageador Portátil", "EcoLife Sandália Casual", "BioZen Blusa Feminina", "Nordic Monitor Cardíaco", "EcoLife Violão Acústico", "UrbanPro Monitor Cardíaco", "EcoLife Ventilador Turbo", "UrbanPro Saia Midi", "Nordic Mouse Gamer", "PetJoy Drone Compacto", "PrimeFlex Caixa de Som", "StudioMax Notebook Slim", "AeroFit Perfume Floral", "StudioMax Fogão Inox", "PrimeFlex Vestido Social", "StudioMax Caixa de Som", "StudioMax Vacina Pet", "UrbanPro Sandália Casual", "Lumina Pincéis Artísticos", "StudioMax Sandália Casual", "Lumina Sandália Casual", "PetJoy Roteador Wi-Fi", "TechWay Bicicleta Dobrável", "PrimeFlex Bicicleta Dobrável", "TechWay Perfume Floral", "PetJoy Fogão Inox", "StudioMax Pincéis Artísticos", "PetJoy Tinta Acrílica", "StudioMax Luminária Decorativa", "Nordic Console Portátil", "UrbanPro Caixa Organizadora", "BioZen Roteador Wi-Fi", "UrbanPro Cadeira de Escritório", "UrbanPro Shampoo Hidratante", "UrbanPro Notebook Slim", "Nordic Pincéis Artísticos", "AeroFit Massageador Portátil", "StudioMax Caixa Organizadora", "BioZen Kit Escolar", "PrimeFlex Sandália Casual", "StudioMax Cortina Blackout", "PrimeFlex Sandália Casual", "EcoLife Cadeira de Escritório", "UrbanPro Shampoo Hidratante", "Lumina Ventilador Turbo", "BioZen Shampoo Hidratante", "PetJoy Pincéis Artísticos", "PetJoy Vestido Social", "Nordic Livro Ilustrado", "BioZen Console Portátil", "Lumina Kit Médicos", "Nordic Perfume Floral", "PetJoy Livro Ilustrado", "Nordic Saia Midi", "PrimeFlex Drone Compacto", "EcoLife Óculos de Sol", "EcoLife Cadeira de Escritório", "EcoLife Livro Ilustrado", "EcoLife Drone Compacto", "StudioMax Vacina Pet", "PetJoy Protetor Solar Facial", "TechWay Luminária Decorativa", "StudioMax Cadeira de Escritório", "Nordic Tinta Acrílica", "TechWay Teclado Mecânico", "Nordic Teclado Mecânico", "PetJoy Bicicleta Dobrável", "UrbanPro Livro Ilustrado", "TechWay Geladeira FrostFree", "EcoLife Tripé Fotográfico", "PrimeFlex Drone Compacto", "Lumina Notebook Slim", "PetJoy Caixa de Som", "Lumina Chaleira Elétrica", "EcoLife Caixa Organizadora", "TechWay Toalha de Banho", "EcoLife Fogão Inox", "BioZen Vacina Pet", "PrimeFlex Blender Gourmet", "AeroFit Tinta Acrílica", "StudioMax Smartwatch", "PetJoy Drone Compacto", "Nordic Óculos de Sol", "StudioMax Monitor Cardíaco", "Nordic Fone Bluetooth", "EcoLife Jogo de Estratégia", "Nordic Vacina Pet", "Nordic Mouse Gamer", "UrbanPro Kit Médicos", "EcoLife Drone Compacto", "AeroFit Ração Premium", "TechWay Geladeira FrostFree", "EcoLife Livro Ilustrado", "Lumina Caixa Organizadora", "TechWay Whey Protein", "Lumina Tinta Acrílica", "UrbanPro Blender Gourmet", "PrimeFlex Kit Médicos", "StudioMax Ração Premium", "PetJoy Carrinho de Bebê", "StudioMax Blender Gourmet", "TechWay Sandália Casual", "StudioMax Geladeira FrostFree", "EcoLife Fone Bluetooth", "PrimeFlex Monitor Cardíaco", "AeroFit Carrinho de Bebê", "EcoLife Saia Midi", "Nordic Protetor Solar Facial", "PrimeFlex Sandália Casual", "PrimeFlex Caixa Organizadora", "PetJoy Fone Bluetooth", "Nordic Tinta Acrílica", "AeroFit Sandália Casual", "Lumina Blusa Feminina", "UrbanPro Perfume Floral", "PrimeFlex Carrinho de Bebê", "TechWay Tinta Acrílica", "EcoLife Bicicleta Dobrável", "PetJoy Perfume Floral", "Lumina Tripé Fotográfico", "AeroFit Luminária Decorativa", "EcoLife Whey Protein", "StudioMax Luminária Decorativa", "AeroFit Cadeira de Escritório", "Lumina Sandália Casual", "BioZen Shampoo Hidratante", "EcoLife Blender Gourmet", "PrimeFlex Drone Compacto", "BioZen Moletom Unissex", "EcoLife Carrinho de Bebê", "BioZen Vestido Social", "EcoLife Moletom Unissex", "StudioMax Smartwatch", "PrimeFlex Kit Escolar", "EcoLife Teclado Mecânico", "UrbanPro Mouse Gamer", "PetJoy Guarda-Roupas", "EcoLife Guarda-Roupas", "BioZen Blender Gourmet", "UrbanPro Cortina Blackout", "StudioMax Whey Protein", "EcoLife Carrinho de Bebê", "StudioMax Câmera Digital", "UrbanPro Monitor HD", "Lumina Óculos de Sol", "TechWay Chaleira Elétrica", "BioZen Carrinho de Bebê", "PetJoy Livro Ilustrado", "EcoLife Jogo de Estratégia", "PetJoy Fogão Inox", "PrimeFlex Mouse Gamer", "EcoLife Óculos de Sol", "TechWay Ração Premium", "UrbanPro Violão Acústico", "Lumina Vestido Social", "AeroFit Perfume Floral", "UrbanPro Fone Bluetooth", "StudioMax Notebook Slim", "PrimeFlex Tinta Acrílica", "PetJoy Protetor Solar Facial", "TechWay Kit Escolar", "StudioMax Kit Médicos", "BioZen Ventilador Turbo", "Nordic Monitor HD", "BioZen Chaleira Elétrica", "PetJoy Livro Ilustrado", "AeroFit Monitor Cardíaco", "TechWay Guia Retrátil", "BioZen Vestido Social", "StudioMax Notebook Slim", "AeroFit Mouse Gamer", "EcoLife Carrinho de Bebê", "UrbanPro Jogo de Estratégia", "StudioMax Vestido Social", "TechWay Cortina Blackout", "BioZen Fogão Inox", "StudioMax Perfume Floral", "TechWay Roteador Wi-Fi", "PrimeFlex Livro Ilustrado", "PetJoy Tripé Fotográfico", "TechWay Roteador Wi-Fi", "EcoLife Kit Médicos", "UrbanPro Smartwatch", "Nordic Roteador Wi-Fi", "BioZen Console Portátil", "PrimeFlex Pincéis Artísticos", "PrimeFlex Cortina Blackout", "UrbanPro Vestido Social", "PetJoy Saia Midi", "BioZen Carrinho de Bebê", "UrbanPro Vacina Pet", "StudioMax Óculos de Sol", "Lumina Roteador Wi-Fi", "UrbanPro Console Portátil", "BioZen Ração Premium", "AeroFit Kit Escolar", "StudioMax Perfume Floral", "PetJoy Teclado Mecânico", "AeroFit Toalha de Banho", "Lumina Jogo Educativo", "TechWay Jogo de Estratégia", "Lumina Monitor HD", "AeroFit Saia Midi", "StudioMax Blusa Feminina", "Lumina Kit Médicos", "PrimeFlex Notebook Slim", "AeroFit Fone Bluetooth", "TechWay Jogo de Estratégia", "TechWay Shampoo Hidratante", "PrimeFlex Blusa Feminina", "PrimeFlex Fone Bluetooth", "UrbanPro Chaleira Elétrica", "UrbanPro Console Portátil", "UrbanPro Luminária Decorativa", "EcoLife Câmera Digital", "Lumina Luminária Decorativa", "StudioMax Shampoo Hidratante", "AeroFit Carrinho de Bebê", "UrbanPro Cortina Blackout", "UrbanPro Vestido Social", "UrbanPro Geladeira FrostFree", "AeroFit Mouse Gamer", "TechWay Geladeira FrostFree", "BioZen Kit Médicos", "StudioMax Roteador Wi-Fi", "PetJoy Teclado Mecânico", "Nordic Bicicleta Dobrável", "AeroFit Carrinho de Bebê", "Nordic Console Portátil", "TechWay Cadeira de Escritório", "Nordic Violão Acústico", "PetJoy Kit Médicos", "Lumina Guarda-Roupas", "TechWay Kit Médicos", "BioZen Tinta Acrílica", "StudioMax Óculos de Sol", "EcoLife Câmera Digital", "Nordic Perfume Floral", "PrimeFlex Fogão Inox", "PrimeFlex Carrinho de Bebê", "PetJoy Óculos de Sol", "PrimeFlex Bicicleta Dobrável", "AeroFit Livro Ilustrado", "StudioMax Jogo Educativo", "Lumina Carrinho de Bebê", "Nordic Roteador Wi-Fi", "UrbanPro Óculos de Sol", "BioZen Perfume Floral", "AeroFit Console Portátil", "AeroFit Massageador Portátil", "PetJoy Óculos de Sol", "AeroFit Kit Escolar", "Lumina Monitor Cardíaco", "Nordic Toalha de Banho", "Lumina Perfume Floral", "PetJoy Bicicleta Dobrável", "TechWay Caixa Organizadora", "Nordic Bicicleta Dobrável", "Lumina Fone Bluetooth", "AeroFit Caixa Organizadora", "PrimeFlex Guia Retrátil", "EcoLife Bicicleta Dobrável", "TechWay Pincéis Artísticos", "UrbanPro Guia Retrátil", "TechWay Massageador Portátil", "BioZen Chaleira Elétrica", "PrimeFlex Chaleira Elétrica", "TechWay Roteador Wi-Fi", "PrimeFlex Guia Retrátil", "AeroFit Perfume Floral", "PetJoy Caixa Organizadora", "TechWay Moletom Unissex", "StudioMax Tripé Fotográfico", "TechWay Óculos de Sol", "AeroFit Drone Compacto", "PetJoy Monitor HD", "StudioMax Console Portátil", "TechWay Bicicleta Dobrável", "UrbanPro Ração Premium", "PetJoy Kit Escolar", "UrbanPro Chaleira Elétrica", "EcoLife Smartwatch", "EcoLife Geladeira FrostFree", "PrimeFlex Luminária Decorativa", "PrimeFlex Console Portátil", "TechWay Violão Acústico", "PrimeFlex Kit Médicos", "PetJoy Caixa Organizadora", "StudioMax Cadeira de Escritório", "Lumina Drone Compacto", "PetJoy Fone Bluetooth", "AeroFit Tripé Fotográfico", "UrbanPro Monitor Cardíaco", "BioZen Smartwatch", "PetJoy Guarda-Roupas", "EcoLife Cadeira de Escritório", "UrbanPro Mouse Gamer", "StudioMax Mouse Gamer", "Lumina Drone Compacto", "AeroFit Tripé Fotográfico", "StudioMax Bicicleta Dobrável", "Nordic Blusa Feminina", "StudioMax Guia Retrátil", "Nordic Perfume Floral", "TechWay Tinta Acrílica", "AeroFit Jogo de Estratégia", "Lumina Vacina Pet", "Lumina Saia Midi", "StudioMax Jogo Educativo", "AeroFit Guia Retrátil", "BioZen Vestido Social", "BioZen Whey Protein", "EcoLife Kit Escolar", "Lumina Kit Escolar", "Lumina Blusa Feminina", "Nordic Roteador Wi-Fi", "AeroFit Caixa Organizadora", "EcoLife Perfume Floral", "UrbanPro Caixa de Som", "EcoLife Caixa Organizadora", "EcoLife Monitor HD", "StudioMax Guarda-Roupas", "Lumina Blusa Feminina", "Lumina Kit Escolar", "PetJoy Ventilador Turbo", "EcoLife Toalha de Banho", "BioZen Monitor HD", "UrbanPro Vestido Social", "TechWay Luminária Decorativa", "BioZen Shampoo Hidratante", "PetJoy Perfume Floral", "AeroFit Vacina Pet", "PrimeFlex Jogo de Estratégia", "Lumina Guia Retrátil", "TechWay Luminária Decorativa", "Lumina Jogo Educativo", "PetJoy Smartwatch", "PetJoy Ração Premium", "Lumina Jogo Educativo", "PetJoy Console Portátil", "EcoLife Câmera Digital", "AeroFit Bicicleta Dobrável", "StudioMax Teclado Mecânico", "AeroFit Drone Compacto", "PrimeFlex Protetor Solar Facial", "PrimeFlex Cadeira de Escritório", "EcoLife Console Portátil", "StudioMax Guia Retrátil", "AeroFit Óculos de Sol", "PrimeFlex Luminária Decorativa", "StudioMax Saia Midi", "AeroFit Whey Protein", "AeroFit Câmera Digital", "PrimeFlex Console Portátil", "Lumina Câmera Digital", "PrimeFlex Perfume Floral", "EcoLife Shampoo Hidratante", "PrimeFlex Shampoo Hidratante", "TechWay Caixa de Som", "UrbanPro Cortina Blackout", "PetJoy Tripé Fotográfico", "EcoLife Guarda-Roupas", "PrimeFlex Caixa Organizadora", "PetJoy Roteador Wi-Fi", "UrbanPro Monitor Cardíaco", "UrbanPro Ração Premium", "AeroFit Livro Ilustrado", "BioZen Massageador Portátil", "StudioMax Carrinho de Bebê", "TechWay Smartwatch", "Lumina Teclado Mecânico", "StudioMax Kit Médicos", "AeroFit Mouse Gamer", "BioZen Óculos de Sol", "PrimeFlex Bicicleta Dobrável", "TechWay Câmera Digital", "BioZen Blender Gourmet", "Lumina Kit Médicos", "PetJoy Cortina Blackout", "PrimeFlex Mouse Gamer", "Nordic Sandália Casual", "PetJoy Cortina Blackout", "PetJoy Jogo Educativo", "UrbanPro Whey Protein", "StudioMax Livro Ilustrado", "PetJoy Whey Protein", "BioZen Shampoo Hidratante", "PrimeFlex Luminária Decorativa", "BioZen Bicicleta Dobrável", "PetJoy Teclado Mecânico", "TechWay Console Portátil", "Nordic Ração Premium", "PetJoy Sandália Casual", "Lumina Monitor Cardíaco", "TechWay Roteador Wi-Fi", "TechWay Console Portátil", "PetJoy Ventilador Turbo", "Lumina Console Portátil", "EcoLife Tripé Fotográfico", "PetJoy Carrinho de Bebê", "BioZen Guarda-Roupas", "AeroFit Violão Acústico", "BioZen Guarda-Roupas", "PetJoy Óculos de Sol", "TechWay Notebook Slim", "UrbanPro Monitor Cardíaco", "EcoLife Fone Bluetooth", "Nordic Violão Acústico", "BioZen Carrinho de Bebê", "PetJoy Drone Compacto", "AeroFit Whey Protein", "EcoLife Fogão Inox", "BioZen Jogo de Estratégia", "Lumina Perfume Floral", "BioZen Vestido Social", "AeroFit Roteador Wi-Fi", "TechWay Smartwatch", "PrimeFlex Massageador Portátil", "StudioMax Jogo de Estratégia", "StudioMax Fone Bluetooth", "EcoLife Saia Midi", "PetJoy Pincéis Artísticos", "Lumina Monitor Cardíaco", "EcoLife Caixa Organizadora", "EcoLife Caixa Organizadora", "EcoLife Kit Médicos", "StudioMax Roteador Wi-Fi", "StudioMax Notebook Slim", "EcoLife Caixa de Som", "AeroFit Ventilador Turbo", "UrbanPro Toalha de Banho", "Nordic Jogo Educativo", "PrimeFlex Blusa Feminina", "BioZen Kit Escolar", "PrimeFlex Livro Ilustrado", "PrimeFlex Blender Gourmet", "Nordic Massageador Portátil", "Lumina Console Portátil", "TechWay Violão Acústico", "Nordic Blusa Feminina", "PetJoy Kit Escolar", "AeroFit Cortina Blackout", "TechWay Fogão Inox", "PrimeFlex Drone Compacto", "BioZen Jogo Educativo", "TechWay Fogão Inox", "StudioMax Toalha de Banho", "PrimeFlex Massageador Portátil", "PrimeFlex Toalha de Banho", "TechWay Cadeira de Escritório", "PrimeFlex Cadeira de Escritório", "PetJoy Perfume Floral", "PetJoy Jogo Educativo", "PrimeFlex Kit Médicos", "PetJoy Kit Escolar", "Nordic Chaleira Elétrica", "BioZen Fone Bluetooth", "PetJoy Massageador Portátil", "PetJoy Câmera Digital", "TechWay Violão Acústico", "AeroFit Ventilador Turbo", "UrbanPro Ventilador Turbo", "AeroFit Teclado Mecânico", "PrimeFlex Câmera Digital", "PrimeFlex Luminária Decorativa", "Nordic Livro Ilustrado", "StudioMax Cortina Blackout", "EcoLife Notebook Slim", "TechWay Toalha de Banho", "BioZen Teclado Mecânico", "BioZen Vacina Pet", "Lumina Vestido Social", "TechWay Kit Médicos", "EcoLife Cortina Blackout", "UrbanPro Ventilador Turbo", "Nordic Fone Bluetooth", "Lumina Óculos de Sol", "Lumina Kit Médicos", "UrbanPro Violão Acústico", "Lumina Kit Escolar", "Lumina Toalha de Banho", "UrbanPro Chaleira Elétrica", "UrbanPro Caixa Organizadora", "UrbanPro Tinta Acrílica", "Lumina Chaleira Elétrica", "EcoLife Cortina Blackout", "TechWay Livro Ilustrado", "BioZen Violão Acústico", "AeroFit Pincéis Artísticos", "AeroFit Livro Ilustrado", "UrbanPro Guia Retrátil", "AeroFit Guarda-Roupas", "StudioMax Kit Médicos", "BioZen Fone Bluetooth", "UrbanPro Ventilador Turbo", "Nordic Fone Bluetooth", "PetJoy Mouse Gamer", "Lumina Guia Retrátil", "Lumina Cortina Blackout", "PetJoy Mouse Gamer", "Nordic Vacina Pet", "BioZen Fone Bluetooth", "TechWay Bicicleta Dobrável", "EcoLife Cadeira de Escritório", "PetJoy Pincéis Artísticos", "UrbanPro Sandália Casual", "Lumina Fogão Inox", "Lumina Caixa Organizadora", "AeroFit Bicicleta Dobrável", "BioZen Vestido Social", "PetJoy Toalha de Banho", "EcoLife Kit Médicos", "PetJoy Kit Médicos", "Lumina Guia Retrátil", "StudioMax Vacina Pet", "Lumina Ventilador Turbo", "TechWay Massageador Portátil", "PetJoy Protetor Solar Facial", "PetJoy Moletom Unissex", "StudioMax Ventilador Turbo", "AeroFit Tinta Acrílica", "UrbanPro Caixa Organizadora", "PetJoy Monitor Cardíaco", "AeroFit Pincéis Artísticos", "PrimeFlex Blusa Feminina", "AeroFit Geladeira FrostFree", "PrimeFlex Luminária Decorativa", "StudioMax Teclado Mecânico", "EcoLife Monitor HD", "TechWay Vacina Pet", "PetJoy Moletom Unissex", "EcoLife Notebook Slim", "AeroFit Ração Premium", "EcoLife Massageador Portátil", "EcoLife Console Portátil", "TechWay Cortina Blackout", "Lumina Jogo de Estratégia", "UrbanPro Vacina Pet", "PrimeFlex Smartwatch", "Lumina Roteador Wi-Fi", "BioZen Whey Protein", "UrbanPro Fogão Inox", "Nordic Luminária Decorativa", "UrbanPro Massageador Portátil", "PrimeFlex Luminária Decorativa", "BioZen Toalha de Banho", "UrbanPro Luminária Decorativa", "StudioMax Kit Escolar", "UrbanPro Mouse Gamer", "EcoLife Geladeira FrostFree", "PetJoy Pincéis Artísticos", "AeroFit Fone Bluetooth", "PrimeFlex Geladeira FrostFree", "StudioMax Teclado Mecânico", "Lumina Caixa Organizadora", "Lumina Caixa Organizadora", "TechWay Drone Compacto", "PrimeFlex Protetor Solar Facial", "EcoLife Fogão Inox", "EcoLife Cadeira de Escritório", "Lumina Sandália Casual", "EcoLife Monitor Cardíaco", "AeroFit Caixa Organizadora", "StudioMax Caixa de Som", "StudioMax Toalha de Banho", "TechWay Caixa de Som", "AeroFit Blusa Feminina", "AeroFit Saia Midi", "PetJoy Protetor Solar Facial", "EcoLife Smartwatch", "PetJoy Massageador Portátil", "BioZen Jogo Educativo", "Nordic Jogo de Estratégia", "Lumina Carrinho de Bebê", "PrimeFlex Drone Compacto", "StudioMax Vestido Social", "PrimeFlex Moletom Unissex", "Nordic Massageador Portátil", "BioZen Moletom Unissex", "AeroFit Smartwatch", "BioZen Perfume Floral", "PetJoy Livro Ilustrado", "PrimeFlex Perfume Floral", "BioZen Geladeira FrostFree", "Nordic Carrinho de Bebê", "StudioMax Caixa Organizadora", "BioZen Mouse Gamer", "TechWay Ventilador Turbo", "AeroFit Roteador Wi-Fi", "PrimeFlex Notebook Slim", "UrbanPro Cadeira de Escritório", "Nordic Perfume Floral", "Lumina Cadeira de Escritório", "TechWay Jogo Educativo", "BioZen Blusa Feminina", "AeroFit Ração Premium", "EcoLife Bicicleta Dobrável", "TechWay Toalha de Banho", "PetJoy Fogão Inox", "Lumina Vestido Social", "Nordic Guarda-Roupas", "BioZen Vacina Pet", "PrimeFlex Luminária Decorativa", "UrbanPro Whey Protein", "Nordic Fone Bluetooth", "TechWay Drone Compacto", "PrimeFlex Console Portátil", "UrbanPro Chaleira Elétrica", "Lumina Console Portátil", "TechWay Câmera Digital", "AeroFit Chaleira Elétrica", "AeroFit Vestido Social", "BioZen Console Portátil", "PetJoy Console Portátil", "StudioMax Jogo Educativo", "UrbanPro Câmera Digital", "BioZen Bicicleta Dobrável", "Nordic Protetor Solar Facial", "PrimeFlex Ventilador Turbo", "UrbanPro Monitor HD", "Lumina Smartwatch", "PetJoy Sandália Casual", "PrimeFlex Whey Protein", "Nordic Notebook Slim", "UrbanPro Violão Acústico", "PetJoy Óculos de Sol", "AeroFit Mouse Gamer", "PrimeFlex Monitor HD", "BioZen Jogo de Estratégia", "StudioMax Perfume Floral", "TechWay Câmera Digital", "EcoLife Jogo de Estratégia", "BioZen Guia Retrátil", "AeroFit Drone Compacto", "PrimeFlex Console Portátil", "EcoLife Livro Ilustrado", "StudioMax Whey Protein", "UrbanPro Massageador Portátil", "BioZen Mouse Gamer", "PrimeFlex Notebook Slim", "StudioMax Console Portátil", "UrbanPro Óculos de Sol", "Nordic Luminária Decorativa", "PrimeFlex Blusa Feminina", "UrbanPro Kit Escolar", "BioZen Pincéis Artísticos", "PetJoy Moletom Unissex", "BioZen Luminária Decorativa", "BioZen Roteador Wi-Fi", "PrimeFlex Cadeira de Escritório", "PrimeFlex Jogo de Estratégia", "PrimeFlex Sandália Casual", "UrbanPro Sandália Casual", "Lumina Toalha de Banho", "TechWay Sandália Casual", "BioZen Luminária Decorativa", "PrimeFlex Sandália Casual", "PetJoy Óculos de Sol", "PrimeFlex Roteador Wi-Fi", "AeroFit Perfume Floral", "AeroFit Kit Médicos", "UrbanPro Jogo de Estratégia", "UrbanPro Livro Ilustrado", "TechWay Chaleira Elétrica", "Nordic Cadeira de Escritório", "PrimeFlex Vacina Pet", "StudioMax Caixa Organizadora", "Lumina Fone Bluetooth", "UrbanPro Cortina Blackout", "PrimeFlex Ração Premium", "AeroFit Drone Compacto", "TechWay Roteador Wi-Fi", "StudioMax Livro Ilustrado", "PetJoy Carrinho de Bebê", "TechWay Pincéis Artísticos", "PrimeFlex Protetor Solar Facial", "StudioMax Ventilador Turbo", "Lumina Mouse Gamer", "PrimeFlex Blusa Feminina", "AeroFit Livro Ilustrado", "EcoLife Vestido Social", "Lumina Tripé Fotográfico", "UrbanPro Smartwatch", "PrimeFlex Tinta Acrílica", "PrimeFlex Câmera Digital", "AeroFit Óculos de Sol", "EcoLife Massageador Portátil", "Nordic Monitor Cardíaco", "TechWay Blender Gourmet", "AeroFit Jogo Educativo", "AeroFit Teclado Mecânico", "EcoLife Shampoo Hidratante", "UrbanPro Carrinho de Bebê", "Nordic Drone Compacto", "TechWay Bicicleta Dobrável", "AeroFit Massageador Portátil", "PetJoy Geladeira FrostFree", "PetJoy Smartwatch", "UrbanPro Blusa Feminina", "AeroFit Bicicleta Dobrável", "TechWay Blender Gourmet", "PrimeFlex Caixa Organizadora", "StudioMax Sandália Casual", "PetJoy Geladeira FrostFree", "Nordic Smartwatch", "Lumina Ventilador Turbo", "PetJoy Jogo Educativo", "PrimeFlex Shampoo Hidratante", "StudioMax Moletom Unissex", "AeroFit Massageador Portátil", "AeroFit Vacina Pet", "Lumina Smartwatch", "EcoLife Cadeira de Escritório", "PetJoy Cadeira de Escritório", "PetJoy Shampoo Hidratante", "TechWay Perfume Floral", "EcoLife Geladeira FrostFree", "Lumina Notebook Slim", "BioZen Violão Acústico", "TechWay Perfume Floral", "Nordic Drone Compacto", "StudioMax Console Portátil", "UrbanPro Drone Compacto", "AeroFit Luminária Decorativa", "Lumina Ventilador Turbo", "BioZen Óculos de Sol", "UrbanPro Guia Retrátil", "BioZen Óculos de Sol", "EcoLife Monitor HD", "BioZen Cortina Blackout", "Nordic Jogo Educativo", "PetJoy Bicicleta Dobrável", "StudioMax Jogo de Estratégia", "StudioMax Ventilador Turbo", "BioZen Mouse Gamer", "Lumina Fogão Inox", "StudioMax Jogo de Estratégia", "BioZen Guia Retrátil", "StudioMax Saia Midi", "TechWay Cadeira de Escritório", "PetJoy Caixa de Som", "BioZen Console Portátil", "BioZen Chaleira Elétrica", "Nordic Violão Acústico", "AeroFit Guia Retrátil", "Nordic Console Portátil", "StudioMax Shampoo Hidratante", "PrimeFlex Óculos de Sol", "Nordic Kit Escolar", "BioZen Shampoo Hidratante", "UrbanPro Cadeira de Escritório", "TechWay Jogo Educativo", "EcoLife Notebook Slim", "BioZen Drone Compacto", "Nordic Óculos de Sol", "AeroFit Notebook Slim", "PrimeFlex Fone Bluetooth", "Nordic Geladeira FrostFree", "TechWay Toalha de Banho", "BioZen Óculos de Sol", "StudioMax Pincéis Artísticos", "Nordic Shampoo Hidratante", "TechWay Cortina Blackout", "PrimeFlex Console Portátil", "EcoLife Bicicleta Dobrável", "EcoLife Vestido Social", "BioZen Massageador Portátil", "BioZen Kit Escolar", "PetJoy Carrinho de Bebê", "Nordic Drone Compacto", "EcoLife Toalha de Banho", "StudioMax Tripé Fotográfico", "PetJoy Cortina Blackout", "TechWay Kit Médicos", "BioZen Notebook Slim", "AeroFit Luminária Decorativa", "StudioMax Toalha de Banho", "StudioMax Fone Bluetooth", "PrimeFlex Massageador Portátil", "BioZen Livro Ilustrado", "UrbanPro Perfume Floral", "Nordic Cortina Blackout", "BioZen Vacina Pet", "Lumina Protetor Solar Facial", "PetJoy Console Portátil", "AeroFit Moletom Unissex", "StudioMax Smartwatch", "PetJoy Fone Bluetooth", "Nordic Sandália Casual", "TechWay Protetor Solar Facial", "BioZen Toalha de Banho", "Nordic Sandália Casual", "PrimeFlex Massageador Portátil", "Nordic Caixa Organizadora", "Lumina Kit Médicos", "PrimeFlex Perfume Floral", "BioZen Carrinho de Bebê", "Lumina Óculos de Sol", "PetJoy Shampoo Hidratante", "EcoLife Ventilador Turbo", "PrimeFlex Caixa Organizadora", "StudioMax Câmera Digital", "TechWay Vestido Social", "BioZen Console Portátil", "PetJoy Guia Retrátil", "UrbanPro Caixa Organizadora", "EcoLife Perfume Floral", "StudioMax Notebook Slim", "StudioMax Chaleira Elétrica", "StudioMax Mouse Gamer", "Nordic Notebook Slim", "Nordic Kit Médicos", "PetJoy Caixa Organizadora", "AeroFit Vestido Social", "EcoLife Mouse Gamer", "StudioMax Caixa de Som", "StudioMax Tinta Acrílica", "PrimeFlex Drone Compacto", "Lumina Livro Ilustrado", "PrimeFlex Massageador Portátil", "StudioMax Tinta Acrílica", "BioZen Fogão Inox", "UrbanPro Drone Compacto", "PrimeFlex Mouse Gamer", "PetJoy Luminária Decorativa", "PetJoy Kit Escolar", "PrimeFlex Chaleira Elétrica", "PetJoy Monitor Cardíaco", "AeroFit Drone Compacto", "AeroFit Óculos de Sol", "AeroFit Jogo de Estratégia", "AeroFit Óculos de Sol", "BioZen Tripé Fotográfico", "EcoLife Toalha de Banho", "BioZen Violão Acústico", "Lumina Notebook Slim", "Lumina Caixa Organizadora", "PrimeFlex Massageador Portátil", "EcoLife Pincéis Artísticos", "BioZen Pincéis Artísticos", "Lumina Whey Protein", "AeroFit Guarda-Roupas", "PetJoy Pincéis Artísticos", "PetJoy Blender Gourmet", "Nordic Perfume Floral", "UrbanPro Whey Protein", "BioZen Perfume Floral", "TechWay Guia Retrátil", "EcoLife Kit Escolar", "TechWay Kit Médicos", "UrbanPro Protetor Solar Facial", "UrbanPro Monitor Cardíaco", "BioZen Notebook Slim", "PetJoy Óculos de Sol", "TechWay Mouse Gamer", "Lumina Perfume Floral", "BioZen Guia Retrátil", "PrimeFlex Óculos de Sol", "TechWay Cortina Blackout", "AeroFit Sandália Casual", "AeroFit Roteador Wi-Fi", "BioZen Roteador Wi-Fi", "StudioMax Kit Médicos", "EcoLife Livro Ilustrado", "UrbanPro Console Portátil", "BioZen Teclado Mecânico", "Nordic Carrinho de Bebê", "BioZen Guia Retrátil", "TechWay Toalha de Banho", "UrbanPro Roteador Wi-Fi", "PrimeFlex Massageador Portátil", "PrimeFlex Geladeira FrostFree", "BioZen Cortina Blackout", "BioZen Jogo Educativo", "Nordic Jogo de Estratégia", "AeroFit Guarda-Roupas", "PetJoy Moletom Unissex", "UrbanPro Geladeira FrostFree", "BioZen Protetor Solar Facial", "UrbanPro Cortina Blackout", "AeroFit Sandália Casual", "Lumina Tripé Fotográfico", "StudioMax Perfume Floral", "TechWay Saia Midi", "BioZen Jogo de Estratégia", "StudioMax Blender Gourmet", "UrbanPro Vestido Social", "AeroFit Luminária Decorativa", "AeroFit Roteador Wi-Fi", "PrimeFlex Teclado Mecânico", "EcoLife Fogão Inox", "PetJoy Protetor Solar Facial", "PrimeFlex Caixa de Som", "PetJoy Tinta Acrílica", "Nordic Roteador Wi-Fi", "Nordic Livro Ilustrado", "TechWay Guarda-Roupas", "TechWay Kit Escolar", "BioZen Saia Midi", "EcoLife Blender Gourmet", "Nordic Saia Midi", "BioZen Blusa Feminina", "BioZen Geladeira FrostFree", "Lumina Jogo Educativo", "PetJoy Shampoo Hidratante", "StudioMax Cortina Blackout", "BioZen Console Portátil", "EcoLife Vacina Pet", "BioZen Ração Premium", "UrbanPro Tripé Fotográfico", "Lumina Guia Retrátil", "TechWay Kit Médicos", "StudioMax Caixa de Som", "Lumina Smartwatch", "StudioMax Console Portátil", "BioZen Fogão Inox", "StudioMax Geladeira FrostFree", "PrimeFlex Óculos de Sol", "Nordic Protetor Solar Facial", "EcoLife Luminária Decorativa", "AeroFit Jogo Educativo", "Lumina Cadeira de Escritório", "Nordic Cadeira de Escritório", "TechWay Mouse Gamer", "AeroFit Blusa Feminina", "TechWay Toalha de Banho", "PrimeFlex Caixa de Som", "UrbanPro Livro Ilustrado", "StudioMax Notebook Slim", "PrimeFlex Livro Ilustrado", "AeroFit Óculos de Sol", "PrimeFlex Violão Acústico"]
];

const STORES_TO_TRY = [
    { id: undefined, name: "Geral" }, 
    { id: "5766", name: "Amazon" },
    { id: "5632", name: "Magalu" },
    { id: "6116", name: "AliExpress" },
    { id: "5938", name: "KaBuM!" }
];

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        product_id_unique VARCHAR(255) NOT NULL,
        product_name TEXT,
        posted_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_posted_time ON posted_products(posted_at);
    `);
    client.release();
  } catch (err) { console.error("❌ Erro DB Setup:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

// --- PASSO 1: BUSCA CASCATA ---
const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    let allProducts: Product[] = [];
    
    // Escolhe um grupo de busca aleatório (ex: Grupo do iPhone)
    const searchGroup = SEARCH_GROUPS[Math.floor(Math.random() * SEARCH_GROUPS.length)];
    
    console.log(`🚀 [Job] Iniciando Cascata para grupo: "${searchGroup[0]}"`);

    // Tenta cada termo da cascata até achar produtos
    for (const keyword of searchGroup) {
        if (allProducts.length >= 3) break; // Já achou o suficiente

        console.log(`   🔎 Tentando termo: "${keyword}"...`);
        
        // Tenta Geral + 1 Loja Específica
        const stores = [STORES_TO_TRY[0], STORES_TO_TRY[Math.floor(Math.random() * (STORES_TO_TRY.length - 1)) + 1]];
        
        for (const store of stores) {
            try {
                await new Promise(r => setTimeout(r, 1200)); // Delay
                
                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 15, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products?.length) {
                    // Validação: Nome deve conter pelo menos uma palavra chave importante
                    // Ex: Se buscou "iPhone 15", aceita "iPhone" no nome.
                    const keyTerms = keyword.toLowerCase().split(" ").filter(w => w.length > 2);
                    
                    const valid = res.products.filter((p: any) => {
                        const normName = p.name.toLowerCase();
                        return keyTerms.some(t => normName.includes(t)) && p.price > 20;
                    });

                    if (valid.length > 0) {
                        console.log(`      ✅ Sucesso! ${valid.length} itens encontrados para "${keyword}".`);
                        allProducts.push(...valid);
                        if (!store.id) break; // Se achou na geral, pula o resto pra economizar tempo
                    }
                }
            } catch (e) {}
        }
        
        if (allProducts.length > 0) break; // Se achou com esse termo, para a cascata.
    }

    // Deduplicação
    const uniqueMap = new Map();
    allProducts.forEach(p => uniqueMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueMap.values());

    console.log(`📦 [Job] Total Final: ${uniqueProducts.length} produtos.`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

const filterStep = createStep({
  id: "filter-products",
  inputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  execute: async ({ inputData }) => {
    if (!inputData.success || !inputData.products.length) return { success: false, newProducts: [] };
    
    const candidates = inputData.products.sort(() => 0.5 - Math.random());
    const finalSelection: Product[] = [];
    const client = await pool.connect();

    try {
        for (const p of candidates) {
            if (finalSelection.length >= 4) break; 

            const res = await client.query(
                `SELECT 1 FROM posted_products WHERE product_id_unique = $1 AND posted_at > NOW() - INTERVAL '3 days'`,
                [p.id]
            );

            if (res.rowCount === 0) finalSelection.push(p);
        }
    } finally { client.release(); }

    if (finalSelection.length > 0) console.log(`✨ [Job] ${finalSelection.length} ofertas prontas.`);
    else console.log("⏸️ [Job] Duplicatas filtradas.");

    return { success: finalSelection.length > 0, newProducts: finalSelection };
  }
});

const copyStep = createStep({
  id: "generate-copy",
  inputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), enrichedProducts: z.array(ProductSchema) }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData.success) return { success: true, enrichedProducts: [] };
    const agent = mastra?.getAgent("promoPublisherAgent");
    const enrichedProducts = [...inputData.newProducts];

    await Promise.all(enrichedProducts.map(async (p) => {
        const price = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        const prompt = `Post Telegram. Produto: ${p.name}. Preço: ${price}. Link: ${p.link}. Emojis!`;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch { p.generatedMessage = ""; }
    }));
    return { success: true, enrichedProducts };
  }
});

const publishStep = createStep({
  id: "publish",
  inputSchema: z.object({ success: z.boolean(), enrichedProducts: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
  execute: async ({ inputData }) => {
    if (!inputData.success) return { success: true, count: 0 };
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHANNEL_ID;
    let count = 0;

    const fetchWithRetry = async (url: string, opts: any, retries = 3) => {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url, opts);
                if (!res.ok) throw new Error(res.statusText);
                return res;
            } catch (err) {
                if (i === retries - 1) throw err;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    };

    for (const p of inputData.enrichedProducts) {
        if (!token || !chat) break;
        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        let text = p.generatedMessage || `🔥 ${p.name}\n💰 ${priceFormatted}`;
        const body: any = { 
            chat_id: chat, parse_mode: "Markdown", 
            text: `${text}\n\n👇 *LINK:* ${p.link}`,
            reply_markup: { inline_keyboard: [[{ text: "🛒 VER NA LOJA", url: p.link }]] }
        };
        if (p.image) { body.photo = p.image; body.caption = body.text; delete body.text; }

        try {
            await fetchWithRetry(
                `https://api.telegram.org/bot${token}/${p.image ? "sendPhoto" : "sendMessage"}`, 
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            );
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2)`, [p.id, p.name]);
            count++;
            console.log(`📢 Postado: ${p.name}`);
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) { console.error(`❌ Erro Telegram ${p.name}:`, e); }
    }
    return { success: true, count };
  }
});

export const promoPublisherWorkflow = createWorkflow({
  id: "promo-workflow",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
})
  .then(fetchStep).then(filterStep).then(copyStep).then(publishStep).commit();
