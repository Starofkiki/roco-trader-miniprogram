const CLOUD_FILE_PREFIX = ''

const CLOUD_IMAGE_PATH_BY_PRODUCT_ID = {
  product_f3815ccc207d: '28abd3b3d68330e60a74b535fc32e90da3f8fa91.png',
  product_1c0245904b81: '5e314a1fcf3d541248bd8b6348553e168285688c.webp',
  product_ad73b9dd0fe7: 'ba30ff04b3dc8bb1cda76b2531aa820f899d98eb.png',
  product_1d689406f6fd: 'f3dabdd279b03c3a370fbb36b384d3bc5060b26b.png',
  product_b63ff99adf87: '20e486c18d390e987a0e91b7147fd85c3426c03b.png',
  product_a1abc1928d26: '5b4ad65c81ef1b1c79fe1ec62ec5a2b3657ce84b.png',
  product_8a0468c63bf3: 'd740ea08628df1305fbf6d209cf0364142a60704.png',
  product_8d66d3570aba: '2515a1189504792d77c0920b16293006934889a3.png',
  product_b7565b6b0285: '800b4e018e9b4ee6a6abf48d379d0d4de0ca65de.png',
  product_b429dd65bb2d: '2ab581614662ec0a65faa91cfcbdb2a6bf9eb967.png',
  product_5ba3ddf3e7de: '961058288b889e6983b15ea16e83e4029fe76527.webp',
  product_28b33d3f6c2b: '6eda3bb4dfd7d0077581e171483fa2658a8de00c.png',
  product_67f4c91f5486: '1b24ffe84fd7aba3100c034e29e3353bc8ebb9b4.png',
  product_033cbb7e5142: '9810851094f20b51bf2bf087c25c964bbd4e7128.png',
  product_66b8d29af3e1: 'c697890b9211d75726517b973525fb698ca61d0e.png',
  product_7307df8ae809: 'd8fd2d5b6e55785f971070e2fadb351da4c0dbe1.png',
  product_d2fbb98158aa: '0fe1e359c37ccb480b5902237c31300e4984dae9.png',
  product_1bd5c9ce700c: 'c7217b27e70ac6de779c98eeed68ba179146d877.png',
  product_3bb047fe45d1: '7f588c98f97404e382ccbd4d254a09ec3670a2ce.png',
  product_7318dc976824: 'cf903380f59abd0cf5b7372074b649d915d59681.png',
  product_f2df3d59cdda: '7f4dbdd442ae7de5d92f8f23dd6c50247fe5b841.png',
  product_887b099fc3f5: '5221bc1ef64b82fb917d4764111d52579992c72a.png',
  product_33dc490ce4c4: '309a859d3821baeff88a3151a47d0aac66b04a89.png',
  product_1a5406d0b214: '5ad765de0db6578e1c035d48a8d16d71b1da7657.png',
  product_62f1d741aa82: 'a251c480ff5a3b4d5bd81ecef2ab04dd934222d2.png',
  product_ce383d6a620b: '4a5bd2bfe8fb1a32ab782b13c7168e492ac36935.png',
  product_a4d65b3897ad: '607a2fbbdc03c1aa369ef94ac33df63c674db9d9.png',
  product_588d0dcd2c76: 'b548e8e1ca9a964c613d29de844b33791ef853ed.png',
  product_986793e19a1f: '765a07c7f355061e7bd5d228cd8a018c132c0f02.png',
  product_9f24b1d4faca: '39222311d16025156467b57366d72cad1d71885f.png',
  product_9e44ff5e565a: '59974a583c180d6af8676d201f5a3fb3c685c2a1.png',
  product_18379d741b68: '0b88a3dd3a93b84ee57baaa197cd5a7eecff561a.png',
  product_04a5db5e6c55: 'cfd0e364cb0eea75fd9e8d6af24f7fbcbfbeaed0.png',
  product_ce4e1906ca55: '207778d4b655420a516763234e81b8b1ac2ae89f.png',
  product_72416eefb028: '03ddedcc04a77028fc6ebd4a721695df55ebc496.png',
  product_5029b6111d05: '3a3b3016e207d70d017f4123fac728a9f95b6696.png',
  product_fe7f7c9eb48c: '4b63e076788e67d132ff3054944c59279433888e.png',
  product_156734594d83: '8aa2a5cbaa5e03522f7044481713acd4093c197d.png',
  product_0141f89056ba: '71bac1ef55b45be2edbd5131d3ee797ef2b47fb0.png',
  product_27f4d30b3fdf: 'e845250b145e1be7d0c665bf2af13dfa46fb0d50.png',
  product_e3c909e0148f: '6049f51b87d0779bcbe543ac87c3dd20c4e0c900.png',
  product_6140a97c5888: '63f12400b589eba9edf54ccd603391811a8fc5ab.png',
  product_23cecd018079: 'a69c3b0f02d79c6424fa4aeb5129569cb6f8f40a.png',
  product_5c327ec369e4: '9ebfde98a92b1686caafde5fd374381d4fb674e5.png',
  product_03915f8baeec: '4f6472b9768377806410ce7c8355249176242721.png',
  product_1510facfb0e3: '8ccbe146e55f3bb10b41a4097452665b33e4bb4d.png',
  product_9f6b0cee2031: '8bceb0af65aaf5883eee7bc7957ce390bf103d35.png',
  product_aa1322813f03: '7dc41c6ba24b84f2ed6050d78153d28937884459.png',
  product_915fddb03502: '99608395088e3b074028059afce33c8441758d35.png',
  product_9f5b8f3283c8: '02f7cfb47a8952078903d110d099ef7fde5573d5.png',
  product_3661067d16c2: '5d7a36265ab3befbb96305aac3be3e353864f650.png',
  product_1d061dae109e: 'd6a4e47407fd5709e445ae415445793965c54b8d.png',
  product_e723d38143c6: 'a18ba419822cb77d0078df93d0e21f5a4dcd444b.png',
  product_fa391ca4ec7d: '4bfd553822e83420a1fe65b02b0bcd64b7b4d07d.png',
  product_4020d230a5af: 'adede75c8fe7041cc37dc3065d577462fa88a860.png',
  product_8de08acf3024: '1331f6380898ee62e6eb753b2bed689d5b3911bf.png',
  product_ffbb28a3eb4a: '7b371065315d57a6238e37a1737e181231c0809c.png',
  product_e21ff87035fc: '64f36cfac22aabbc1b60669ee63b0f7b5af77864.png',
  product_401b1669edff: '7f90e2fece668c4df75026aacbbf004220a488c5.png',
  product_61cab847cd7b: 'f9bc3a6965494d2e042af16985acee3dfe32448c.png',
  product_2d69a943b6d0: '66d8be8bf92269b70bb350702c733bc9421a3839.png',
  product_ef9c8dbe26a3: '9b23fb63190eb0484e5996673940c744395461cd.png'
}

const PENDING_MIGRATION_PRODUCT_IDS = [
  'product_67f4c91f5486',
  'product_033cbb7e5142',
  'product_66b8d29af3e1',
  'product_7307df8ae809',
  'product_72416eefb028',
  'product_e21ff87035fc'
]

function getProductImageFileId(productId) {
  const cloudPath = CLOUD_IMAGE_PATH_BY_PRODUCT_ID[productId]
  return CLOUD_FILE_PREFIX && cloudPath ? `${CLOUD_FILE_PREFIX}${cloudPath}` : ''
}

module.exports = {
  CLOUD_FILE_PREFIX,
  CLOUD_IMAGE_PATH_BY_PRODUCT_ID,
  PENDING_MIGRATION_PRODUCT_IDS,
  getProductImageFileId
}
