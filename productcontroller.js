const mongoose = require('mongoose');
const Product = require('../models/product');

// 1. Create Product API
exports.createProduct = async (req, res, next) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product,
    });
  } catch (err) {
    next(err);
  }
};

// 2. Get All Products — Filtering, Sorting & Pagination
exports.getAllProducts = async (req, res, next) => {
  try {
    const {
      search,
      category,
      minPrice,
      maxPrice,
      inStock,
      sortBy = 'createdAt',
      order = 'desc',
      page = 1,
      limit = 10,
    } = req.query;

    const filter = {};

    // Keyword search on name or SKU
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
      ];
    }

    // Category filter
    if (category) {
      filter.category = category;
    }

    // Price range filter
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.price = {};
      if (minPrice !== undefined) filter.price.$gte = Number(minPrice);
      if (maxPrice !== undefined) filter.price.$lte = Number(maxPrice);
    }

    // Availability filter
    if (inStock === 'true') {
      filter.stock = { $gt: 0 };
    } else if (inStock === 'false') {
      filter.stock = 0;
    }

    // Sorting
    const sortOrder = order === 'asc' ? 1 : -1;
    const sortOptions = { [sortBy]: sortOrder };

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const [products, totalRecords] = await Promise.all([
      Product.find(filter).sort(sortOptions).skip(skip).limit(limitNum),
      Product.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      count: products.length,
      pagination: {
        totalRecords,
        currentPage: pageNum,
        totalPages: Math.ceil(totalRecords / limitNum),
        limit: limitNum,
      },
      data: products,
    });
  } catch (err) {
    next(err);
  }
};

// 3. Get Single Product by ID
exports.getProductById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid Product ID format' });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
};

// 4. Update Product Details (General metadata/price)
exports.updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid Product ID format' });
    }

    const updatedProduct = await Product.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updatedProduct) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: updatedProduct,
    });
  } catch (err) {
    next(err);
  }
};

// 5. Safe Stock Adjustment (Restock & Sale Operations)
exports.adjustStock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { operation, quantity } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid Product ID format' });
    }

    if (!['restock', 'sale'].includes(operation)) {
      return res.status(400).json({
        success: false,
        message: 'Operation must be either "restock" or "sale"',
      });
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be a positive integer',
      });
    }

    const delta = operation === 'restock' ? quantity : -quantity;

    // Atomic conditional update: for sales, only decrement if stock >= quantity
    const query =
      operation === 'sale'
        ? { _id: id, stock: { $gte: quantity } }
        : { _id: id };

    const updatedProduct = await Product.findOneAndUpdate(
      query,
      { $inc: { stock: delta } },
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      const exists = await Product.findById(id);
      if (!exists) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      return res.status(400).json({
        success: false,
        message: `Insufficient stock for sale. Available stock: ${exists.stock}`,
      });
    }

    res.status(200).json({
      success: true,
      message: `Stock ${operation} successful`,
      data: updatedProduct,
    });
  } catch (err) {
    next(err);
  }
};

// 6. Delete Product
exports.deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid Product ID format' });
    }

    const deletedProduct = await Product.findByIdAndDelete(id);
    if (!deletedProduct) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully',
      data: deletedProduct,
    });
  } catch (err) {
    next(err);
  }
};

// 7. Low-Stock Alert Report
exports.getLowStockReport = async (req, res, next) => {
  try {
    // Allow optional query override (?threshold=5), otherwise compare against each product's lowStockThreshold
    const { threshold } = req.query;

    const filter =
      threshold !== undefined
        ? { stock: { $lte: Number(threshold) } }
        : { $expr: { $lte: ['$stock', '$lowStockThreshold'] } };

    const lowStockProducts = await Product.find(filter).sort({ stock: 1 });

    res.status(200).json({
      success: true,
      alertCount: lowStockProducts.length,
      data: lowStockProducts,
    });
  } catch (err) {
    next(err);
  }
};

// 8. Category-wise Inventory Summary (MongoDB Aggregation Pipeline)
exports.getCategorySummary = async (req, res, next) => {
  try {
    const summary = await Product.aggregate([
      {
        $group: {
          _id: '$category',
          totalProducts: { $sum: 1 },
          totalStockUnits: { $sum: '$stock' },
          totalInventoryValue: { $sum: { $multiply: ['$price', '$stock'] } },
          averagePrice: { $avg: '$price' },
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' },
          lowStockItems: {
            $sum: {
              $cond: [{ $lte: ['$stock', '$lowStockThreshold'] }, 1, 0],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          category: '$_id',
          totalProducts: 1,
          totalStockUnits: 1,
          totalInventoryValue: { $round: ['$totalInventoryValue', 2] },
          averagePrice: { $round: ['$averagePrice', 2] },
          minPrice: 1,
          maxPrice: 1,
          lowStockItems: 1,
        },
      },
      {
        $sort: { totalInventoryValue: -1 },
      },
    ]);

    res.status(200).json({
      success: true,
      categoriesCount: summary.length,
      data: summary,
    });
  } catch (err) {
    next(err);
  }
};